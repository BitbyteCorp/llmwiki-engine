# Claude Code 설치 자료
Claude Code의 llmwiki Skill 설치와 선택적인 로컬 플러그인 자료다.

## 배경
공통 프롬프트의 단일 원본은 `skills/llmwiki/SKILL.md`다. 이 디렉터리의 자료는 설치 시 Skill 디렉터리의 `client/`에 복사되며 활성 MCP 설정을 덮어쓰지 않는다.

## 내용
### 설치와 갱신
`llmwiki skill install claude-code`는 개인용 `~/.claude/skills/llmwiki`에 설치한다. `--project <dir>`는 `<dir>/.claude/skills/llmwiki`를 선택한다. `llmwiki skill status claude-code`로 버전과 로컬 수정을 확인하고 `llmwiki skill update claude-code`로 갱신한다. 같은 프로젝트 옵션을 조회와 갱신에도 사용한다. 로컬 수정과 표식 없는 기존 파일은 기본적으로 보존하며 검토 후 `--force`로 Skill 파일만 교체한다.

### 별도 연결과 로그인
[공식 MCP 문서](https://code.claude.com/docs/en/mcp)에 따라 `claude mcp add --transport http --scope user llmwiki "<ENGINE_URL>/mcp"`로 실제 엔진을 등록한다. 프로젝트 설정은 `--scope project`를 사용한다. Claude Code에서 `/mcp`를 열어 브라우저 OAuth 로그인을 완료한다. 새 세션에서 `/llmwiki`를 호출하고 실제 검색과 노트 읽기로 확인한다. 설치기는 로그인과 연결 설정을 수행하지 않는다.

### 선택적인 임시 플러그인
이 엔진 저장소의 루트에서 다음 명령은 [공식 플러그인 문서](https://code.claude.com/docs/en/plugins/create)의 구조에 맞는 새 임시 플러그인을 구성한다. 기존 플러그인이나 사용자 설정을 덮어쓰지 않는다.

```bash
PLUGIN_DIR="$(mktemp -d)"
cp -R skills/claude-code/. "$PLUGIN_DIR/"
mkdir -p "$PLUGIN_DIR/skills"
cp -R skills/llmwiki "$PLUGIN_DIR/skills/llmwiki"
export LLMWIKI_URL="https://wiki.example.com"
claude plugin validate "$PLUGIN_DIR"
claude --plugin-dir "$PLUGIN_DIR"
```

`LLMWIKI_URL`은 실제 엔진 기본 URL로 바꾸며 끝의 `/`와 `/mcp`를 넣지 않는다. `.mcp.json`은 `${LLMWIKI_URL}/mcp`를 참조하고 비밀값을 포함하지 않는다. `.claude-plugin/plugin.json`은 플러그인 manifest다. 설치 디렉터리의 `client/`는 완성된 플러그인 루트가 아니므로 그대로 `--plugin-dir`에 전달하지 않는다. 플러그인 호출은 `/llmwiki:llmwiki`이며 `--plugin-dir` 로딩은 해당 세션에만 적용된다. `/mcp`에서 별도 OAuth 로그인을 완료한다.

## 관련 문서
저장소의 `docs/skills.md`는 버전 표식, 수정 보호, 전체 설치 위치를 설명한다. `docs/mcp.md`와 `docs/auth.md`는 도구와 인증 계약을 설명한다.
