package appserver

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"sync"
)

var (
	ErrClosed              = errors.New("app server connection closed")
	ErrProtocolUnsupported = errors.New("executor app server protocol unsupported")
)

type Process interface {
	Stdin() io.WriteCloser
	Stdout() io.ReadCloser
	Wait() error
	Kill() error
}

type Client struct {
	process       Process
	stdin         io.WriteCloser
	writeMu       sync.Mutex
	stateMu       sync.Mutex
	nextID        uint64
	pending       map[string]chan rpcMessage
	notifications chan Notification
	done          chan struct{}
	closeOnce     sync.Once
	readErr       error
}

func NewClient(process Process) *Client {
	client := &Client{
		process:       process,
		stdin:         process.Stdin(),
		pending:       make(map[string]chan rpcMessage),
		notifications: make(chan Notification, 64),
		done:          make(chan struct{}),
	}
	go client.readLoop(process.Stdout())
	return client
}

func (c *Client) Initialize(ctx context.Context, version string) error {
	var ignored struct {
		PlatformFamily string `json:"platformFamily"`
		PlatformOS     string `json:"platformOs"`
		UserAgent      string `json:"userAgent"`
	}
	if err := c.Call(ctx, MethodInitialize, initializeParams{
		ClientInfo:   clientInfo{Name: "aicrm-agent-executor", Title: "AiCRM", Version: version},
		Capabilities: initializeCapabilities{ExperimentalAPI: true},
	}, &ignored); err != nil {
		return fmt.Errorf("%w: initialize", ErrProtocolUnsupported)
	}
	return c.notify(MethodInitialized, struct{}{})
}

func (c *Client) StartDeviceCodeLogin(ctx context.Context) (DeviceCodeChallenge, error) {
	var response loginStartResponse
	if err := c.Call(ctx, MethodAccountLoginStart, map[string]any{"type": "chatgptDeviceCode"}, &response); err != nil {
		return DeviceCodeChallenge{}, err
	}
	if response.Type != "chatgptDeviceCode" || response.LoginID == "" || response.VerificationURL == "" || response.UserCode == "" || response.AuthURL != "" {
		return DeviceCodeChallenge{}, ErrProtocolUnsupported
	}
	return DeviceCodeChallenge{
		LoginID: response.LoginID, VerificationURL: response.VerificationURL, UserCode: response.UserCode,
	}, nil
}

func (c *Client) WaitLoginCompleted(ctx context.Context, loginID string) (LoginCompletion, error) {
	for {
		select {
		case <-ctx.Done():
			return LoginCompletion{}, ctx.Err()
		case <-c.done:
			return LoginCompletion{}, c.connectionError()
		case notification, ok := <-c.notifications:
			if !ok {
				return LoginCompletion{}, c.connectionError()
			}
			if notification.Method != MethodLoginCompleted {
				continue
			}
			var payload loginCompletedNotification
			if json.Unmarshal(notification.Params, &payload) != nil || payload.LoginID == nil || *payload.LoginID != loginID {
				continue
			}
			return LoginCompletion{LoginID: loginID, Success: payload.Success}, nil
		}
	}
}

func (c *Client) CancelLogin(ctx context.Context, loginID string) error {
	return c.Call(ctx, MethodAccountLoginCancel, map[string]any{"loginId": loginID}, &struct{}{})
}

func (c *Client) ReadAccount(ctx context.Context, refreshToken bool) (AccountReadResult, error) {
	var response AccountReadResult
	if err := c.Call(ctx, MethodAccountRead, map[string]any{"refreshToken": refreshToken}, &response); err != nil {
		return AccountReadResult{}, err
	}
	return response, nil
}

func (c *Client) Logout(ctx context.Context) error {
	return c.Call(ctx, MethodAccountLogout, struct{}{}, &struct{}{})
}

func (c *Client) ListModels(ctx context.Context) ([]Model, error) {
	models := make([]Model, 0, 32)
	var cursor *string
	for page := 0; page < 20; page++ {
		var response modelListResponse
		params := map[string]any{"includeHidden": true, "limit": 100}
		if cursor != nil {
			params["cursor"] = *cursor
		}
		if err := c.Call(ctx, MethodModelList, params, &response); err != nil {
			return nil, err
		}
		models = append(models, response.Data...)
		if response.NextCursor == nil || *response.NextCursor == "" {
			return models, nil
		}
		cursor = response.NextCursor
	}
	return nil, errors.New("model catalog pagination limit exceeded")
}

func (c *Client) Call(ctx context.Context, method string, params, result any) error {
	if method == "" {
		return ErrProtocolUnsupported
	}
	c.stateMu.Lock()
	c.nextID++
	idNumber := c.nextID
	id := strconv.FormatUint(idNumber, 10)
	response := make(chan rpcMessage, 1)
	c.pending[id] = response
	c.stateMu.Unlock()

	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": idNumber, "method": method, "params": params,
	})
	if err == nil {
		err = c.writeLine(payload)
	}
	if err != nil {
		c.removePending(id)
		return err
	}

	select {
	case <-ctx.Done():
		c.removePending(id)
		return ctx.Err()
	case <-c.done:
		c.removePending(id)
		return c.connectionError()
	case message := <-response:
		if message.Error != nil {
			return fmt.Errorf("app server rpc error %d", message.Error.Code)
		}
		if result == nil || len(message.Result) == 0 {
			return nil
		}
		if json.Unmarshal(message.Result, result) != nil {
			return ErrProtocolUnsupported
		}
		return nil
	}
}

func (c *Client) Close() error {
	c.closeOnce.Do(func() {
		_ = c.stdin.Close()
		_ = c.process.Kill()
	})
	<-c.done
	return c.process.Wait()
}

func (c *Client) notify(method string, params any) error {
	payload, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	if err != nil {
		return err
	}
	return c.writeLine(payload)
}

func (c *Client) writeLine(payload []byte) error {
	if len(payload) > maximumProtocolMessageBytes {
		return ErrProtocolUnsupported
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.stdin.Write(append(payload, '\n')); err != nil {
		return ErrClosed
	}
	return nil
}

func (c *Client) readLoop(reader io.ReadCloser) {
	defer reader.Close()
	defer close(c.done)
	defer close(c.notifications)
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64<<10), maximumProtocolMessageBytes)
	for scanner.Scan() {
		var message rpcMessage
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			c.setReadError(ErrProtocolUnsupported)
			return
		}
		if len(message.ID) > 0 && message.Method == "" {
			id := normalizeID(message.ID)
			c.stateMu.Lock()
			pending := c.pending[id]
			delete(c.pending, id)
			c.stateMu.Unlock()
			if pending != nil {
				pending <- message
			}
			continue
		}
		if message.Method != "" && len(message.ID) == 0 {
			params := append(json.RawMessage(nil), message.Params...)
			select {
			case c.notifications <- Notification{Method: message.Method, Params: params}:
			default:
				c.setReadError(errors.New("app server notification buffer overflow"))
				return
			}
			continue
		}
		if message.Method != "" && len(message.ID) > 0 {
			_ = c.respondMethodNotFound(message.ID)
		}
	}
	if err := scanner.Err(); err != nil {
		c.setReadError(ErrClosed)
	} else {
		c.setReadError(ErrClosed)
	}
}

func (c *Client) respondMethodNotFound(id json.RawMessage) error {
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": json.RawMessage(id),
		"error": map[string]any{"code": -32601, "message": "method not supported"},
	})
	if err != nil {
		return err
	}
	return c.writeLine(payload)
}

func (c *Client) removePending(id string) {
	c.stateMu.Lock()
	delete(c.pending, id)
	c.stateMu.Unlock()
}

func (c *Client) setReadError(err error) {
	c.stateMu.Lock()
	if c.readErr == nil {
		c.readErr = err
	}
	c.stateMu.Unlock()
}

func (c *Client) connectionError() error {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.readErr != nil {
		return c.readErr
	}
	return ErrClosed
}

func normalizeID(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var number json.Number
	if json.Unmarshal(raw, &number) == nil {
		return number.String()
	}
	return ""
}
