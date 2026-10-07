CREATE TABLE acl_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prefix TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'role', 'everyone')),
  subject TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('none', 'read', 'write')),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (prefix, subject_type, subject),
  CHECK ((subject_type = 'everyone' AND subject = '') OR
    (subject_type = 'role' AND subject IN ('admin', 'editor', 'viewer')) OR
    (subject_type = 'user' AND subject <> ''))
);
CREATE INDEX acl_rules_subject ON acl_rules(subject_type, subject, prefix);

-- Persist policy identity across process restarts and invalidate every cached reader.
CREATE TABLE acl_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL
);
INSERT INTO acl_policy (id, revision) VALUES (1, 0);
CREATE TRIGGER acl_rules_insert AFTER INSERT ON acl_rules BEGIN
  UPDATE acl_policy SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER acl_rules_update AFTER UPDATE ON acl_rules BEGIN
  UPDATE acl_policy SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER acl_rules_delete AFTER DELETE ON acl_rules BEGIN
  UPDATE acl_policy SET revision = revision + 1 WHERE id = 1;
END;
