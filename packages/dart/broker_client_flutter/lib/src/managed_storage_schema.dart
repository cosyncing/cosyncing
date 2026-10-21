/// Auxiliary ownership/inventory tables. They store no file bodies and accept
/// only opaque item identifiers at the cleanup boundary.
const managedStorageSchema = <String>[
  '''CREATE TABLE IF NOT EXISTS managed_device_files (
    id TEXT PRIMARY KEY, location TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
    completed_at INTEGER NOT NULL, category TEXT NOT NULL,
    source TEXT, session TEXT)''',
  '''CREATE TABLE IF NOT EXISTS device_storage_inventories (
    id TEXT PRIMARY KEY, measured_at INTEGER NOT NULL)''',
  '''CREATE TABLE IF NOT EXISTS device_storage_items (
    inventory TEXT NOT NULL, id TEXT NOT NULL, location TEXT NOT NULL,
    label TEXT NOT NULL, completed_at INTEGER NOT NULL, category TEXT NOT NULL,
    source TEXT, session TEXT, version TEXT, bytes INTEGER,
    eligible INTEGER NOT NULL, reason TEXT, PRIMARY KEY(inventory,id))''',
  '''CREATE TABLE IF NOT EXISTS device_storage_plans (
    id TEXT PRIMARY KEY, inventory TEXT NOT NULL, expires INTEGER NOT NULL,
    state TEXT NOT NULL, lease_until INTEGER)''',
  '''CREATE TABLE IF NOT EXISTS device_storage_plan_items (
    plan TEXT NOT NULL, id TEXT NOT NULL, location TEXT NOT NULL,
    version TEXT NOT NULL, bytes INTEGER NOT NULL,
    outcome TEXT, reclaimed INTEGER, PRIMARY KEY(plan,id))''',
];
