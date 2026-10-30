package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const DocumentMaxBytes = 1048576

var documentSlug = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

type Document struct {
	PublicationVersion int        `json:"publicationVersion,omitempty"`
	PublishedAt        *time.Time `json:"publishedAt,omitempty"`
	ID                 string     `json:"id"`
	Slug               string     `json:"slug"`
	Category           string     `json:"category"`
	Status             string     `json:"status"`
	Version            int        `json:"version"`
	Revision           int64      `json:"revision"`
	UpdatedBy          string     `json:"updatedBy"`
	UpdatedAt          time.Time  `json:"updatedAt"`
	Title              string     `json:"title"`
	Markdown           string     `json:"markdown"`
	Note               string     `json:"note"`
	Dirty              bool       `json:"dirty"`
}
type DocumentInput struct {
	Slug             string `json:"slug"`
	Category         string `json:"category"`
	Title            string `json:"title"`
	Markdown         string `json:"markdown"`
	Note             string `json:"note"`
	ExpectedRevision int64  `json:"expectedRevision"`
	Version          int    `json:"version"`
	PublishKey       string `json:"publishKey"`
}

func (v DocumentInput) Valid() bool {
	return !strings.Contains(v.Title+v.Markdown+v.Note, "\x00") && len(v.Slug) <= 80 && documentSlug.MatchString(v.Slug) && strings.TrimSpace(v.Title) != "" && len([]rune(v.Title)) <= 120 && utf8.ValidString(v.Markdown) && len(v.Markdown) <= DocumentMaxBytes && len([]rune(v.Note)) <= 500 && (v.Category == "agreement" || v.Category == "privacy" || v.Category == "notice" || v.Category == "other")
}

type DocumentVersion struct {
	PublishedBy string    `json:"publishedBy,omitempty"`
	Version     int       `json:"version"`
	Title       string    `json:"title"`
	Markdown    string    `json:"markdown,omitempty"`
	Note        string    `json:"note"`
	Digest      string    `json:"digest"`
	PublishedAt time.Time `json:"publishedAt"`
}
type PublicDocument struct {
	CurrentVersion int    `json:"currentVersion"`
	Slug           string `json:"slug"`
	DocumentVersion
}
type DocumentBinding struct {
	Purpose    string  `json:"purpose"`
	DocumentID *string `json:"documentId"`
	Revision   int64   `json:"revision"`
}

const documentSelect = `SELECT d.id,d.slug,d.category,d.status,d.current_version,d.revision,d.updated_by,d.updated_at,f.title,f.markdown,f.note,f.dirty,(SELECT v.published_at FROM ky_document_version v WHERE v.document_id=d.id AND v.version=d.current_version) FROM ky_document d JOIN ky_document_draft f ON f.document_id=d.id`

type rowScanner interface{ Scan(...any) error }

func scanDocument(row rowScanner) (d Document, err error) {
	err = row.Scan(&d.ID, &d.Slug, &d.Category, &d.Status, &d.Version, &d.Revision, &d.UpdatedBy, &d.UpdatedAt, &d.Title, &d.Markdown, &d.Note, &d.Dirty, &d.PublishedAt)
	if err == sql.ErrNoRows {
		err = ErrNotFound
	}
	return
}
func (s *Store) Document(ctx context.Context, id string) (Document, error) {
	return scanDocument(s.db.QueryRowContext(ctx, documentSelect+` WHERE d.id=$1`, id))
}
func (s *Store) Documents(ctx context.Context, q, category, status string, page, size int) ([]Document, Page, error) {
	p := Page{Page: page, PageSize: size}
	items := []Document{}
	where := ` WHERE ($1='' OR f.title ILIKE '%'||$1||'%' OR d.slug ILIKE '%'||$1||'%') AND ($2='' OR d.category=$2) AND ($3='' OR d.status=$3)`
	err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_document d JOIN ky_document_draft f ON f.document_id=d.id`+where, q, category, status).Scan(&p.Total)
	if err != nil {
		return nil, p, err
	}
	rows, err := s.db.QueryContext(ctx, documentSelect+where+` ORDER BY d.updated_at DESC,d.id LIMIT $4 OFFSET $5`, q, category, status, size, (page-1)*size)
	if err != nil {
		return nil, p, err
	}
	defer rows.Close()
	for rows.Next() {
		d, e := scanDocument(rows)
		if e != nil {
			return nil, p, e
		}
		d.Markdown = ""
		items = append(items, d)
	}
	return items, p, rows.Err()
}
func (s *Store) CreateDocument(ctx context.Context, id, actor string, in DocumentInput) (Document, error) {
	if !in.Valid() {
		return Document{}, ErrValidation
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Document{}, err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO ky_document(id,slug,category,updated_by) VALUES($1,$2,$3,$4)`, id, in.Slug, in.Category, actor)
	if err != nil {
		return Document{}, classifyWriteErr(err)
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO ky_document_draft(document_id,title,markdown,note) VALUES($1,$2,$3,$4)`, id, in.Title, in.Markdown, in.Note)
	if err != nil {
		return Document{}, err
	}
	if err = tx.Commit(); err != nil {
		return Document{}, err
	}
	return s.Document(ctx, id)
}

// Global transactional lock serializes bindings, publish, delete and offline transitions.
// Draft saves also use CAS; no network or filesystem work runs while the lock is held.
func lockDocuments(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext('platform-documents'))`)
	return err
}
func (s *Store) ChangeDocument(ctx context.Context, id, actor, action string, in DocumentInput) (Document, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Document{}, err
	}
	defer tx.Rollback()
	if err = lockDocuments(ctx, tx); err != nil {
		return Document{}, err
	}
	d, err := scanDocument(tx.QueryRowContext(ctx, documentSelect+` WHERE d.id=$1 FOR UPDATE OF d`, id))
	if err != nil {
		return d, err
	}
	if action == "publish" {
		if len(in.PublishKey) < 8 || len(in.PublishKey) > 100 || strings.Contains(in.PublishKey, "\x00") {
			return d, ErrValidation
		}
		var version int
		var sourceRevision int64
		e := tx.QueryRowContext(ctx, `SELECT version,source_revision FROM ky_document_version WHERE document_id=$1 AND publish_key=$2`, id, in.PublishKey).Scan(&version, &sourceRevision)
		if e == nil {
			if sourceRevision != in.ExpectedRevision {
				return d, ErrConflict
			}
			d.PublicationVersion = version
			return d, nil
		}
		if e != sql.ErrNoRows {
			return d, e
		}
	}
	if d.Revision != in.ExpectedRevision {
		return d, ErrConflict
	}
	switch action {
	case "draft":
		if !in.Valid() {
			return d, ErrValidation
		}
		if d.Version > 0 && in.Slug != d.Slug {
			return d, ErrValidation
		}
		_, err = tx.ExecContext(ctx, `UPDATE ky_document SET slug=$2,category=$3 WHERE id=$1`, id, in.Slug, in.Category)
		if err != nil {
			return d, classifyWriteErr(err)
		}
		_, err = tx.ExecContext(ctx, `UPDATE ky_document_draft SET title=$2,markdown=$3,note=$4,dirty=NOT EXISTS(SELECT 1 FROM ky_document_version v JOIN ky_document d ON d.id=v.document_id AND d.current_version=v.version WHERE d.id=$1 AND v.title=$2 AND v.markdown=$3 AND v.note=$4) WHERE document_id=$1`, id, in.Title, in.Markdown, in.Note)
	case "publish":
		if strings.TrimSpace(d.Markdown) == "" || (!d.Dirty && d.Status == "published") {
			return d, ErrValidation
		}
		digest := sha256.Sum256([]byte(d.Markdown))
		d.Version++
		_, err = tx.ExecContext(ctx, `INSERT INTO ky_document_version(document_id,version,title,markdown,note,digest,actor_id,publish_key,source_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id, d.Version, d.Title, d.Markdown, d.Note, hex.EncodeToString(digest[:]), actor, in.PublishKey, in.ExpectedRevision)
		if err != nil {
			break
		}
		_, err = tx.ExecContext(ctx, `UPDATE ky_document SET status='published',current_version=$2 WHERE id=$1`, id, d.Version)
		if err != nil {
			break
		}
		_, err = tx.ExecContext(ctx, `UPDATE ky_document_draft SET dirty=false WHERE document_id=$1`, id)
	case "restore":
		var v DocumentVersion
		err = tx.QueryRowContext(ctx, `SELECT title,markdown,note FROM ky_document_version WHERE document_id=$1 AND version=$2`, id, in.Version).Scan(&v.Title, &v.Markdown, &v.Note)
		if err == sql.ErrNoRows {
			return d, ErrNotFound
		}
		if err != nil {
			break
		}
		_, err = tx.ExecContext(ctx, `UPDATE ky_document_draft SET title=$2,markdown=$3,note=$4,dirty=true WHERE document_id=$1`, id, v.Title, v.Markdown, v.Note)
	case "unpublish", "delete":
		var bound bool
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ky_document_link_binding WHERE document_id=$1)`, id).Scan(&bound)
		if err != nil {
			break
		}
		if bound {
			return d, ErrConflict
		}
		if action == "delete" {
			if d.Version != 0 {
				return d, ErrConflict
			}
			_, err = tx.ExecContext(ctx, `DELETE FROM ky_document WHERE id=$1`, id)
		} else {
			if d.Status != "published" {
				return d, ErrConflict
			}
			_, err = tx.ExecContext(ctx, `UPDATE ky_document SET status='offline' WHERE id=$1`, id)
		}
	default:
		return d, ErrValidation
	}
	if err != nil {
		return d, classifyWriteErr(err)
	}
	if action != "delete" {
		_, err = tx.ExecContext(ctx, `UPDATE ky_document SET revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1`, id, actor)
		if err != nil {
			return d, err
		}
	}
	if err = tx.Commit(); err != nil {
		return d, err
	}
	if action == "delete" {
		return d, nil
	}
	saved, err := s.Document(ctx, id)
	if action == "publish" {
		saved.PublicationVersion = d.Version
	}
	return saved, err
}
func (s *Store) DocumentVersions(ctx context.Context, id string) ([]DocumentVersion, error) {
	if _, err := s.Document(ctx, id); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT actor_id,version,title,note,digest,published_at FROM ky_document_version WHERE document_id=$1 ORDER BY version DESC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DocumentVersion{}
	for rows.Next() {
		var v DocumentVersion
		if err = rows.Scan(&v.PublishedBy, &v.Version, &v.Title, &v.Note, &v.Digest, &v.PublishedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *Store) DocumentVersion(ctx context.Context, id string, version int) (DocumentVersion, error) {
	var v DocumentVersion
	err := s.db.QueryRowContext(ctx, `SELECT actor_id,version,title,markdown,note,digest,published_at FROM ky_document_version WHERE document_id=$1 AND version=$2`, id, version).Scan(&v.PublishedBy, &v.Version, &v.Title, &v.Markdown, &v.Note, &v.Digest, &v.PublishedAt)
	if err == sql.ErrNoRows {
		err = ErrNotFound
	}
	return v, err
}
func (s *Store) PublicDocument(ctx context.Context, slug string, version int) (PublicDocument, error) {
	var v PublicDocument
	err := s.db.QueryRowContext(ctx, `SELECT d.current_version,d.slug,v.version,v.title,v.markdown,v.note,v.digest,v.published_at FROM ky_document d JOIN ky_document_version v ON v.document_id=d.id AND v.version=CASE WHEN $2=0 THEN d.current_version ELSE $2 END WHERE d.slug=$1 AND d.status='published'`, slug, version).Scan(&v.CurrentVersion, &v.Slug, &v.Version, &v.Title, &v.Markdown, &v.Note, &v.Digest, &v.PublishedAt)
	if err == sql.ErrNoRows {
		err = ErrNotFound
	}
	return v, err
}
func (s *Store) DocumentBindings(ctx context.Context) ([]DocumentBinding, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT purpose,document_id,revision FROM ky_document_link_binding ORDER BY purpose`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DocumentBinding{}
	for rows.Next() {
		var b DocumentBinding
		if err = rows.Scan(&b.Purpose, &b.DocumentID, &b.Revision); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}
func (s *Store) BindDocument(ctx context.Context, actor string, b DocumentBinding) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = lockDocuments(ctx, tx); err != nil {
		return err
	}
	if b.DocumentID != nil {
		var ok bool
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ky_document WHERE id=$1 AND status='published')`, *b.DocumentID).Scan(&ok)
		if err != nil {
			return err
		}
		if !ok {
			return ErrValidation
		}
	}
	result, err := tx.ExecContext(ctx, `UPDATE ky_document_link_binding SET document_id=$2,revision=revision+1,updated_by=$3,updated_at=now() WHERE purpose=$1 AND revision=$4`, b.Purpose, b.DocumentID, actor, b.Revision)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrConflict
	}
	return tx.Commit()
}

type PublicDocumentLink struct {
	Purpose string `json:"purpose"`
	Slug    string `json:"slug"`
	Title   string `json:"title"`
	Version int    `json:"version"`
	URL     string `json:"url"`
}

func (s *Store) PublicDocumentLinks(ctx context.Context) ([]PublicDocumentLink, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT b.purpose,d.slug,v.title,v.version FROM ky_document_link_binding b JOIN ky_document d ON d.id=b.document_id AND d.status='published' JOIN ky_document_version v ON v.document_id=d.id AND v.version=d.current_version ORDER BY b.purpose`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PublicDocumentLink{}
	for rows.Next() {
		var v PublicDocumentLink
		if err = rows.Scan(&v.Purpose, &v.Slug, &v.Title, &v.Version); err != nil {
			return nil, err
		}
		v.URL = "/legal/" + v.Slug
		out = append(out, v)
	}
	return out, rows.Err()
}
