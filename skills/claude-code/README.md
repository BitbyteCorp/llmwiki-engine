# Claude Code 로컬 플러그인

이 디렉터리는 `llmwiki` 플러그인의 manifest와 MCP 설정을 제공하며, 공통 Skill은 `skills/llmwiki/SKILL.md`에서 복사해 구성한다.

## 로컬 구성과 실행

[공식 플러그인 생성 문서](https://code.claude.com/docs/en/plugins/create)에 따라 플러그인 루트에 `.claude-plugin/plugin.json`, `.mcp.json`, `skills/llmwiki/SKILL.md`를 함께 둔다. [공식 manifest 경로 규칙](https://code.claude.com/docs/en/plugins/manifest-reference#containment-and-existence)에 따라 구성 파일은 플러그인 루트 안에 있어야 하므로, 저장소 밖으로 이어지는 Skill 참조 대신 설치 시 복사하는 방식을 사용한다. 저장소에는 공통 `SKILL.md` 하나만 유지한다.

아래 명령은 엔진 저장소 루트에서 실행하며, 임시 디렉터리에 완성된 플러그인을 구성한다. 이미 사용하는 `llmwiki` 플러그인을 덮어쓰지 않는다.

```bash
PLUGIN_DIR="$(mktemp -d)"
cp -R skills/claude-code/. "$PLUGIN_DIR/"
mkdir -p "$PLUGIN_DIR/skills"
cp -R skills/llmwiki "$PLUGIN_DIR/skills/llmwiki"
export LLMWIKI_URL="https://wiki.example.com"
claude plugin validate "$PLUGIN_DIR"
claude --plugin-dir "$PLUGIN_DIR"
```

`https://wiki.example.com`은 예시이며, 실제 배포된 엔진의 기본 URL로 바꾼다. `LLMWIKI_URL`에는 끝의 `/`와 `/mcp`를 넣지 않는다. [공식 MCP 환경 변수 문서](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json)에 따라 `.mcp.json`의 HTTP `url`에서 `${LLMWIKI_URL}`을 확장해 `/mcp`에 연결한다. 변수는 Claude Code를 실행하는 셸에서 설정하며, 비어 있거나 정의되지 않으면 먼저 실제 URL을 설정한다.

플러그인의 `.mcp.json`은 다음과 같으며, OAuth를 사용하므로 정적 인증 헤더나 비밀값을 넣지 않는다.

```json
{
  "mcpServers": {
    "llmwiki": {
      "type": "http",
      "url": "${LLMWIKI_URL}/mcp"
    }
  }
}
```

## 로그인과 확인

Claude Code 안에서 `/mcp`를 열고 플러그인의 `llmwiki` 서버 인증을 시작해 브라우저 로그인을 완료한다. [공식 MCP OAuth 문서](https://code.claude.com/docs/en/mcp#authenticate-with-remote-mcp-servers)에 따라 연결 상태를 `/mcp`에서 확인한다. Skill 배치만으로 OAuth 로그인까지 완료되지는 않는다.

[공식 플러그인 생성 문서](https://code.claude.com/docs/en/plugins/create)에 따라 직접 호출 이름은 `/llmwiki:llmwiki`이며, 지식 질문이나 재사용할 지식 발견에서도 설명에 따라 선택된다. `/llmwiki:llmwiki`를 실행한 뒤 실제 지식 질문에서 `search`와 `read_note`가 사용되고 답변에 노트 경로가 인용되는지 확인한다. 능동 쓰기는 `editor` 또는 `admin` 권한에서 가능하며 `write`가 반환한 작업 ID는 반영 완료와 구분한다.

`--plugin-dir` 로딩은 해당 세션에만 적용되며 이후 세션에서도 같은 경로를 전달한다. 공통 Skill을 수정하면 복사한 `skills/llmwiki`를 새 내용으로 교체한 뒤 새 세션을 시작한다. 로컬 구성을 더 이상 사용하지 않으면 이 명령으로 생성한 임시 플러그인 디렉터리를 제거한다. marketplace 등록과 공개 배포 방법은 아직 정하지 않았으며, 이 로컬 실행 절차는 배포 정책을 확정하지 않는다.
