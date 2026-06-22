package store

import (
	"database/sql"
	"strconv"
	"strings"
)

func itoa(i int) string { return strconv.Itoa(i) }

func affectedOrNotFound(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// isUniqueViolation detects a PostgreSQL unique_violation (SQLSTATE 23505).
// The pgx stdlib driver surfaces the SQLSTATE inside the error string.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "23505") || strings.Contains(msg, "duplicate key")
}

// isForeignKeyViolation detects a PostgreSQL foreign_key_violation (SQLSTATE 23503),
// e.g. when a referenced agency/parent department/department id does not exist.
func isForeignKeyViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "23503") || strings.Contains(msg, "violates foreign key")
}

// classifyWriteErr maps unique and foreign-key violations to ErrConflict so
// callers respond 409 rather than 500. Other errors pass through unchanged.
func classifyWriteErr(err error) error {
	if isUniqueViolation(err) || isForeignKeyViolation(err) {
		return ErrConflict
	}
	return err
}
