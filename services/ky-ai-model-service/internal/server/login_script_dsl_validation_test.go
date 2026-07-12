package server

import "testing"

func TestExtractJSONDSLAllowsPublicActions(t *testing.T) {
	content := `{
		"version": 1,
		"purpose": "account_detect",
		"steps": [
			{"action":"clickText","text":"扫码登录"},
			{"action":"clickSelector","selector":"[data-testid=login]"},
			{"action":"wait","ms":100},
			{"action":"waitForElement","elementKey":"data-testid:profile"},
			{"action":"captureElement","elementKey":"data-testid:qr","resultKey":"qrCodeDataUrl"},
			{"action":"readText","elementKey":"data-testid:profile","resultKey":"profileText"},
			{"action":"navigateAllowedUrl","url":"https://creator.douyin.com/"}
		]
	}`
	if _, err := extractJSONDSL(content, "account_detect"); err != nil {
		t.Fatalf("expected public DSL to pass validation: %v", err)
	}
}

func TestExtractJSONDSLRejectsSensitiveAndUnknownActions(t *testing.T) {
	for _, action := range []string{"readStorage", "readIndexedDB", "executeJavaScript"} {
		t.Run(action, func(t *testing.T) {
			content := `{"version":1,"purpose":"account_detect","steps":[{"action":"` + action + `"}]}`
			if _, err := extractJSONDSL(content, "account_detect"); err == nil {
				t.Fatalf("expected %s to be rejected", action)
			}
		})
	}
}

func TestExtractJSONDSLRejectsStepWithoutAction(t *testing.T) {
	content := `{"version":1,"purpose":"account_detect","steps":[{"selector":"body"}]}`
	if _, err := extractJSONDSL(content, "account_detect"); err == nil {
		t.Fatal("expected a step without an action to be rejected")
	}
}
