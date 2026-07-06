// Thin wrapper so the skill can be symlinked into a personal skills directory
// (~/.claude/skills or ~/.cursor/skills). Node resolves this import from the
// file's real path, so it lands in the repo.
import '../../../bin/chunk.js';
