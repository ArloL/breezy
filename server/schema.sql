CREATE TABLE spaces (id BINARY(16) PRIMARY KEY, token_hash BINARY(32) NOT NULL, version BIGINT NOT NULL);
CREATE TABLE records (space BINARY(16) NOT NULL, id BINARY(16) NOT NULL, version BIGINT NOT NULL, data MEDIUMBLOB NOT NULL,
                      PRIMARY KEY (space, id));
CREATE INDEX records_by_version ON records (space, version);
