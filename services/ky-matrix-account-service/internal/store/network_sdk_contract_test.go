package store

import (
	"reflect"
	"testing"
)

func TestNormalizeNetworkCapabilitiesDefaultsReadOnly(t *testing.T) {
	got, err := NormalizeNetworkCapabilities(nil)
	if err != nil {
		t.Fatalf("default capabilities: %v", err)
	}
	want := DefaultNetworkCapabilities()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("default capabilities = %#v, want %#v", got, want)
	}
	if HasNetworkCapability(got, NetworkCapabilityInterceptRequest) || HasNetworkCapability(got, NetworkCapabilityInterceptResponse) {
		t.Fatal("default capabilities must not grant interception")
	}
}

func TestNormalizeNetworkCapabilitiesCanonicalAndExplicitInterception(t *testing.T) {
	got, err := NormalizeNetworkCapabilities([]string{
		NetworkCapabilityInterceptResponse,
		NetworkCapabilitySubscribeRequest,
		NetworkCapabilityInterceptRequest,
	})
	if err != nil {
		t.Fatalf("explicit capabilities: %v", err)
	}
	want := []string{NetworkCapabilitySubscribeRequest, NetworkCapabilityInterceptRequest, NetworkCapabilityInterceptResponse}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("capabilities = %#v, want %#v", got, want)
	}
}

func TestNormalizeNetworkCapabilitiesRejectsUnknownEmptyAndDuplicate(t *testing.T) {
	for _, values := range [][]string{{"unknown"}, {""}, {NetworkCapabilitySubscribeRequest, NetworkCapabilitySubscribeRequest}} {
		if _, err := NormalizeNetworkCapabilities(values); err != ErrValidation {
			t.Fatalf("values %#v error = %v, want ErrValidation", values, err)
		}
	}
}
