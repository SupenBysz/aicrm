package store

import "github.com/Kysion/KyaiCRM/services/ky-org-service/internal/domains"

func (s *Store) Domains() domains.Store { return domains.Store{DB: s.db} }
