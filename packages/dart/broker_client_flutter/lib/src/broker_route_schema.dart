/// Route metadata is separate from legacy profile rows. Secure references are
/// journaled before publication; no secret is stored in this database.
final brokerRouteSchema = <String>[
  '''CREATE TABLE IF NOT EXISTS broker_route_servers (
    profile TEXT PRIMARY KEY, incarnation TEXT NOT NULL, payload TEXT NOT
        NULL)''',
  '''CREATE TABLE IF NOT EXISTS broker_proxy_profiles (
    id TEXT PRIMARY KEY, payload TEXT NOT NULL)''',
  '''CREATE TABLE IF NOT EXISTS broker_proxy_secret_journal (
    id TEXT PRIMARY KEY, new_ref TEXT, old_ref TEXT, payload TEXT NOT NULL)''',
  '''CREATE TABLE IF NOT EXISTS broker_route_migrations (
    profile TEXT NOT NULL, incarnation TEXT NOT NULL,
    legacy_scope TEXT NOT NULL, target_scope TEXT NOT NULL,
    credential_ref TEXT, state TEXT NOT NULL, prepared_payload TEXT,
    PRIMARY KEY(profile,incarnation,legacy_scope))''',
  '''CREATE TABLE IF NOT EXISTS broker_profile_merges (
    id TEXT PRIMARY KEY, survivor TEXT NOT NULL, removed_profile TEXT NOT NULL,
    credential_ref TEXT, pairing_ref TEXT, state TEXT NOT NULL)''',
  '''CREATE TABLE IF NOT EXISTS broker_recovered_drafts (
    source TEXT NOT NULL, tool TEXT NOT NULL, session TEXT NOT NULL,
    original_source TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(source,tool,session,original_source))''',
  '''CREATE TABLE IF NOT EXISTS broker_retired_setting_prefixes (
    prefix TEXT PRIMARY KEY, profile TEXT NOT NULL)''',
  for (final table in [
    'session_outbox_rows',
    'session_transcript_rows',
    'artifact_transfer_rows',
    'session_draft_rows',
    'roster_snapshot_rows',
    'attention_event_rows',
    'attention_cursor_rows',
  ])
    for (final operation in ['INSERT', 'UPDATE'])
      '''CREATE TRIGGER IF NOT EXISTS route_fence_${table}_$operation
        BEFORE $operation ON $table
        WHEN EXISTS (SELECT 1 FROM broker_route_migrations
          WHERE legacy_scope=NEW.broker_profile_id AND state='complete')
        BEGIN SELECT RAISE(IGNORE); END''',
  for (final operation in ['INSERT', 'UPDATE'])
    '''CREATE TRIGGER IF NOT EXISTS route_settings_fence_$operation
      BEFORE $operation ON app_setting_rows
      WHEN EXISTS (SELECT 1 FROM broker_retired_setting_prefixes
        WHERE NEW.key=prefix OR
          (substr(prefix,-1)=':' AND substr(NEW.key,1,length(prefix))=prefix))
      BEGIN SELECT RAISE(IGNORE); END''',
];
