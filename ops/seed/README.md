# KyaiCRM Seed Assets

This directory stores generated or structured seed assets for Phase 1.

Planned seed coverage:

- `platform_root` workspace constant.
- Platform owner user and membership.
- Built-in platform / agency / enterprise roles.
- Permission dictionary entries.
- Menu permissions.
- Default system settings.
- Optional default AI provider and model configuration.

Executable SQL seed content currently lives in `ops/db/008_seed.sql`.

## Development Login

For local and test environments only, the default development login is:

```text
account: platform_owner
password: admin123456
```

`ops/db/008_seed.sql` intentionally keeps `CHANGE_ME_HASH` as a placeholder. During the Auth / Bootstrap implementation phase, `scripts/seed_dev_data.sh` must generate a bcrypt hash for `admin123456` and update or insert the `platform_owner` password credential before login acceptance tests run.

Production environments must replace this credential and generate a new password hash.
