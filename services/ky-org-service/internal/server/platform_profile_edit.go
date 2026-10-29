package server

import (
	"encoding/json"
	"io"
	"net/http"
)

func (s *Server) editPlatformProfile(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in struct {
		ExpectedRevision string                     `json:"expectedRevision"`
		Fields           map[string]json.RawMessage `json:"fields"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16384)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(&in) != nil {
		writeError(w, r, 400, "validation_error", "请检查配置字段和版本")
		return
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		writeError(w, r, 400, "validation_error", "请求格式无效")
		return
	}
	if in.ExpectedRevision == "" {
		writeError(w, r, 428, "revision_required", "请刷新配置后重试，当前表单缺少版本")
		return
	}
	out, err := s.store.EditPlatformProfile(r.Context(), in.ExpectedRevision, wc.UserID, requestID(r), in.Fields)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, out)
}
