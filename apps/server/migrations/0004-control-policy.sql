-- Who controls playback (ADR 0030 §4): room configuration like the title, not personal data.
-- Existing and seeded rooms keep today's behaviour. Kicks and mutes are never stored (ADR 0030 §2, §3).
ALTER TABLE rooms ADD COLUMN control_policy TEXT NOT NULL DEFAULT 'everyone' CHECK (control_policy IN ('everyone', 'owner'));
