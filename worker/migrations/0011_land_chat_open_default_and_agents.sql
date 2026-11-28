-- Default Land Chat Access to Everyone On Site (Google Login) ('open')
-- and add per-land Paired Agentic Users toggle (chat_allow_agents, allowed by default = 1).
ALTER TABLE land_settings ADD COLUMN chat_allow_agents INTEGER NOT NULL DEFAULT 1;
UPDATE land_settings SET chat_access_mode = 'open' WHERE chat_access_mode = 'contributors';
