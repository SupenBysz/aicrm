package server

import (
	"net/http"
	"strconv"
)

func parsePage(r *http.Request) (page, pageSize int) {
	page = atoiDefault(r.URL.Query().Get("page"), 1)
	if page < 1 {
		page = 1
	}
	pageSize = atoiDefault(r.URL.Query().Get("pageSize"), 20)
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	return page, pageSize
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return v
}

func validStatus(status string, allowed ...string) bool {
	for _, a := range allowed {
		if status == a {
			return true
		}
	}
	return false
}
