package credentialfs

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"golang.org/x/text/unicode/norm"
)

const credentialTreeDigestAlgorithm = "aicrm-credential-tree-rfc8785-nfc-v1"

type sharedCredentialTreeFixture struct {
	Version         int                               `json:"version"`
	Algorithm       string                            `json:"algorithm"`
	Vectors         []sharedCredentialTreeVector      `json:"vectors"`
	NegativeVectors []sharedCredentialTreeNegativeVec `json:"negativeVectors"`
}

type sharedCredentialTreeVector struct {
	Name                  string                     `json:"name"`
	Files                 []sharedCredentialTreeFile `json:"files"`
	ExpectedManifestPaths []string                   `json:"expectedManifestPaths"`
	ExpectedDigest        string                     `json:"expectedDigest"`
}

type sharedCredentialTreeNegativeVec struct {
	Name          string                     `json:"name"`
	Files         []sharedCredentialTreeFile `json:"files"`
	ExpectedError string                     `json:"expectedError"`
}

type sharedCredentialTreeFile struct {
	Path          string `json:"path"`
	ContentBase64 string `json:"contentBase64"`
}

func TestDigestTreeMatchesSharedDesktopFixture(t *testing.T) {
	fixture := loadSharedCredentialTreeFixture(t)
	if fixture.Version != 1 || fixture.Algorithm != credentialTreeDigestAlgorithm {
		t.Fatalf("unsupported credential fixture version=%d algorithm=%q", fixture.Version, fixture.Algorithm)
	}
	for _, vector := range fixture.Vectors {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			root := t.TempDir()
			writeSharedCredentialFiles(t, root, vector.Files)
			paths := make([]string, 0, len(vector.Files))
			for _, file := range vector.Files {
				paths = append(paths, norm.NFC.String(file.Path))
			}
			sort.Slice(paths, func(i, j int) bool {
				return bytes.Compare([]byte(paths[i]), []byte(paths[j])) < 0
			})
			if !reflect.DeepEqual(paths, vector.ExpectedManifestPaths) {
				t.Fatalf("fixture manifest paths=%q expected=%q", paths, vector.ExpectedManifestPaths)
			}
			digest, err := DigestTree(root)
			if err != nil {
				t.Fatal(err)
			}
			if digest != vector.ExpectedDigest {
				t.Fatalf("digest=%s expected=%s", digest, vector.ExpectedDigest)
			}
		})
	}
	for _, vector := range fixture.NegativeVectors {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			if vector.ExpectedError != "normalized_path_collision" {
				t.Fatalf("unknown negative fixture error %q", vector.ExpectedError)
			}
			root := t.TempDir()
			writeSharedCredentialFiles(t, root, vector.Files)
			if _, err := DigestTree(root); !errors.Is(err, ErrInvalidPath) {
				t.Fatalf("negative fixture accepted: %v", err)
			}
		})
	}
}

func loadSharedCredentialTreeFixture(t *testing.T) sharedCredentialTreeFixture {
	t.Helper()
	target := filepath.Join("..", "..", "..", "..", "docs", "testdata", "aicrm_credential_tree_vectors.json")
	raw, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	var fixture sharedCredentialTreeFixture
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func writeSharedCredentialFiles(t *testing.T, root string, files []sharedCredentialTreeFile) {
	t.Helper()
	for _, file := range files {
		if file.Path == "" || strings.HasPrefix(file.Path, "/") {
			t.Fatalf("unsafe fixture path %q", file.Path)
		}
		for _, segment := range strings.Split(file.Path, "/") {
			if segment == "" || segment == "." || segment == ".." {
				t.Fatalf("unsafe fixture path %q", file.Path)
			}
		}
		content, err := base64.StdEncoding.DecodeString(file.ContentBase64)
		if err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(root, filepath.FromSlash(file.Path))
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}
