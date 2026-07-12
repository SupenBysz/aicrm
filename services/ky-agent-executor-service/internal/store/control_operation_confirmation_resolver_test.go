package store

import "testing"

func TestValidOperationConfirmationAction(t *testing.T) {
	t.Parallel()
	for _, action := range []string{
		OperationConfirmationForceRevoke,
		OperationConfirmationRebindDevice,
		OperationConfirmationUnbindDevice,
	} {
		if !validOperationConfirmationAction(action) {
			t.Fatalf("expected %q to be valid", action)
		}
	}
	for _, action := range []string{"", "force-revoke", "rebind", "delete_executor"} {
		if validOperationConfirmationAction(action) {
			t.Fatalf("expected %q to be invalid", action)
		}
	}
}
