'use client'

import { useEffect, useState } from 'react'
import { Copy, ExternalLink, Plug, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorNotice, Loading } from '@/components/common'
import { notify } from '@/components/notifications'

type SkillGuide = {
  target: 'claude-code' | 'codex' | 'hermes' | 'cline' | 'kiro' | 'qwen-code'
  source: string
  invocation: string
}
type McpGuide = {
  source: string
  location: string
  value: string
  steps: string
  login: string
  loginCommand?: string
  loginSource?: string
}
type ClientGuide = {
  id: string
  label: string
  skill?: SkillGuide
  mcp?: (url: string) => McpGuide
  unverifiedMcp?: { source: string; reason: string }
}
const initialClient: ClientGuide = {
  id: 'claude-code',
  label: 'Claude Code',
  skill: { target: 'claude-code', source: 'https://code.claude.com/docs/en/skills', invocation: '새 세션에서 /llmwiki로 호출하세요.' },
  mcp: url => ({
    source: 'https://code.claude.com/docs/en/mcp',
    location: '터미널 · 개인 연결',
    value: `claude mcp add --transport http --scope user llmwiki '${url.replace(/'/g, "'\\''")}'`,
    steps: '터미널에서 개인 연결을 등록하세요. 프로젝트 범위는 --scope project를 사용합니다.',
    login: 'Claude Code에서 /mcp를 열어 브라우저 OAuth 인증을 완료하세요.',
  }),
}
const clients: ClientGuide[] = [
  initialClient,
  {
    id: 'codex', label: 'Codex',
    skill: { target: 'codex', source: 'https://developers.openai.com/codex/skills', invocation: '새 세션에서 /skills 또는 $llmwiki로 호출하세요.' },
    mcp: url => ({
      source: 'https://developers.openai.com/codex/mcp', location: '~/.codex/config.toml',
      value: `[mcp_servers.llmwiki]\nurl = ${JSON.stringify(url)}`,
      steps: '기존 TOML 설정에 병합하세요. 신뢰한 프로젝트는 .codex/config.toml을 사용할 수 있습니다.',
      login: '아래 명령으로 브라우저 인증을 완료하고 새 세션에서 /mcp로 확인하세요.', loginCommand: 'codex mcp login llmwiki',
    }),
  },
  {
    id: 'hermes', label: 'Hermes',
    skill: { target: 'hermes', source: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/skills', invocation: '새 세션에서 /llmwiki로 호출하세요. 프로젝트 설치는 Git 프로젝트 루트에서 수행하고 아래 별도 신뢰 승인을 완료하세요.' },
    mcp: url => ({
      source: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp', location: '~/.hermes/config.yaml',
      value: `mcp_servers:\n  llmwiki:\n    url: ${JSON.stringify(url)}\n    auth: oauth`,
      steps: '기존 mcp_servers에 병합하세요. 기존 세션은 /reload-mcp로 연결을 다시 읽을 수 있습니다.',
      login: '별도 터미널에서 아래 명령으로 브라우저 인증을 완료하세요.', loginCommand: 'hermes mcp login llmwiki',
    }),
  },
  {
    id: 'gemini-cli', label: 'Gemini CLI',
    skill: { target: 'codex', source: 'https://geminicli.com/docs/cli/skills/', invocation: '/skills list로 확인하세요. 관련 작업에서 에이전트가 activate_skill로 활성화하며 사용자 승인을 요청합니다.' },
    mcp: url => ({
      source: 'https://geminicli.com/docs/tools/mcp-server', location: '~/.gemini/settings.json',
      value: JSON.stringify({ mcpServers: { llmwiki: { httpUrl: url } } }, null, 2),
      steps: '기존 mcpServers에 병합하세요. 프로젝트 설정은 .gemini/settings.json을 사용합니다.',
      login: 'Gemini CLI 대화에서 아래 명령을 실행해 브라우저 OAuth 인증을 완료하세요.', loginCommand: '/mcp auth llmwiki',
    }),
  },
  {
    id: 'opencode', label: 'OpenCode',
    skill: { target: 'codex', source: 'https://opencode.ai/docs/skills', invocation: '에이전트가 관련 작업에서 skill({ name: "llmwiki" })로 불러옵니다. 설치만으로 /llmwiki 명령이 등록되지는 않습니다.' },
    mcp: url => ({
      source: 'https://opencode.ai/docs/mcp-servers', location: 'opencode.json',
      value: JSON.stringify({ mcp: { llmwiki: { type: 'remote', url } } }, null, 2),
      steps: '기존 mcp에 병합하세요. 개인 설정은 ~/.config/opencode/opencode.json을 사용합니다.',
      login: '아래 명령으로 브라우저 OAuth 인증을 완료하고 opencode mcp list로 상태를 확인하세요.', loginCommand: 'opencode mcp auth llmwiki',
    }),
  },
  {
    id: 'cursor', label: 'Cursor',
    skill: { target: 'codex', source: 'https://cursor.com/docs/skills', invocation: '관련 작업에서 자동 활성화되며 Agent 채팅의 / 메뉴에서 llmwiki를 선택할 수도 있습니다.' },
    mcp: url => ({
      source: 'https://cursor.com/docs/mcp', location: '~/.cursor/mcp.json',
      value: JSON.stringify({ mcpServers: { llmwiki: { url } } }, null, 2),
      steps: '기존 mcpServers에 병합하세요. 프로젝트 전용 설정은 .cursor/mcp.json을 사용합니다.',
      login: 'Customize의 MCP 도구 화면에서 연결하고 브라우저 인증을 완료하세요. Cursor CLI에서는 같은 설정으로 아래 명령을 사용할 수 있습니다.', loginCommand: 'agent mcp login llmwiki',
      loginSource: 'https://cursor.com/docs/cli/mcp',
    }),
  },
  {
    id: 'vscode', label: 'GitHub Copilot · VS Code',
    skill: { target: 'codex', source: 'https://code.visualstudio.com/docs/agent-customization/agent-skills', invocation: '에이전트가 설명에 따라 자동 선택하며 채팅에서 /llmwiki로 직접 호출할 수도 있습니다.' },
    mcp: url => ({
      source: 'https://code.visualstudio.com/docs/agents/reference/mcp-configuration', location: '.vscode/mcp.json',
      value: JSON.stringify({ servers: { llmwiki: { type: 'http', url } } }, null, 2),
      steps: '기존 servers에 병합하고 MCP 서버를 시작하세요. 개인 연결은 VS Code 사용자 프로필에 설정할 수 있습니다.',
      login: '서버 신뢰 확인과 첫 연결의 브라우저 OAuth 인증을 완료한 뒤 에이전트 도구 목록에서 확인하세요.',
    }),
  },
  {
    id: 'copilot-cli', label: 'GitHub Copilot CLI',
    skill: { target: 'codex', source: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills', invocation: '설치 후 /skills reload로 다시 읽으세요. 관련 작업에서 자동 선택되며 /llmwiki로 직접 호출할 수도 있습니다.' },
    mcp: url => ({
      source: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers', location: '~/.copilot/mcp-config.json',
      value: JSON.stringify({ mcpServers: { llmwiki: { type: 'http', url, tools: ['*'] } } }, null, 2),
      steps: '기존 mcpServers에 병합하세요. 프로젝트는 .mcp.json 또는 .github/mcp.json을 사용하며 .vscode/mcp.json은 읽지 않습니다.',
      login: 'Copilot CLI 대화에서 아래 명령으로 서버 OAuth 인증을 완료하세요. copilot login은 Copilot 계정 로그인으로, 서버 인증과 다릅니다.', loginCommand: '/mcp auth llmwiki',
      loginSource: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference',
    }),
  },
  {
    id: 'cline', label: 'Cline',
    skill: { target: 'cline', source: 'https://docs.cline.bot/customization/skills', invocation: '관련 작업에서 자동 활성화되며 채팅의 / 메뉴에서 llmwiki를 선택할 수도 있습니다.' },
    mcp: url => ({
      source: 'https://docs.cline.bot/mcp/mcp-overview', location: '~/.cline/data/settings/cline_mcp_settings.json',
      value: JSON.stringify({ mcpServers: { llmwiki: { type: 'streamableHttp', url } } }, null, 2),
      steps: 'Cline CLI 전용 예시입니다. CLI의 기존 mcpServers에 병합하세요. 확장의 설정·인증과는 별개입니다.',
      login: 'Cline CLI에서 아래 명령을 실행하고 llmwiki 서버의 Authorize OAuth를 선택해 브라우저 인증을 완료하세요.', loginCommand: 'cline mcp',
    }),
  },
  {
    id: 'windsurf', label: 'Windsurf · Devin Desktop',
    skill: { target: 'codex', source: 'https://docs.devin.ai/desktop/cascade/skills', invocation: 'Cascade가 설명에 따라 자동 선택하며 @llmwiki로 명시적으로 호출할 수도 있습니다.' },
    unverifiedMcp: { source: 'https://docs.devin.ai/desktop/cascade/mcp', reason: '공식 Cascade 문서는 원격 HTTP와 OAuth 지원을 명시하지만 정확한 로그인 동작을 안내하지 않습니다. 검증된 MCP OAuth 연결 가이드는 제공하지 않으며 Devin CLI의 로그인 명령을 대신 사용하지 마세요.' },
  },
  {
    id: 'roo-code', label: 'Roo Code',
    skill: { target: 'codex', source: 'https://roocodeinc.github.io/Roo-Code/features/skills/', invocation: '설명에 따라 자동 발견·선택하며 필요한 Skill은 에이전트의 skill 도구로 불러옵니다.' },
    unverifiedMcp: { source: 'https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo', reason: '공식 문서는 원격 Streamable HTTP를 안내하지만 OAuth 로그인 흐름은 확인되지 않았습니다. 검증된 MCP OAuth 연결 가이드는 제공하지 않습니다. Skill 설치만으로 엔진에 연결되지는 않습니다.' },
  },
  {
    id: 'kiro', label: 'Kiro',
    skill: { target: 'kiro', source: 'https://kiro.dev/docs/skills.md', invocation: '설명에 따라 자동 활성화되며 /llmwiki로 직접 호출할 수도 있습니다.' },
    mcp: url => ({
      source: 'https://kiro.dev/docs/mcp/configuration.md', location: '~/.kiro/settings/mcp.json',
      value: JSON.stringify({ mcpServers: { llmwiki: { url } } }, null, 2),
      steps: '기존 mcpServers에 병합하세요. 프로젝트 설정은 .kiro/settings/mcp.json을 사용합니다. 엔진의 동적 클라이언트 등록을 사용하므로 정적 clientId나 비밀값을 넣지 않습니다.',
      login: '연결할 때 자동으로 열리는 브라우저에서 OAuth 인증을 완료하세요. Kiro CLI에서 다시 인증하려면 /mcp auth를 사용합니다.',
    }),
  },
  {
    id: 'amp', label: 'Amp',
    skill: { target: 'codex', source: 'https://ampcode.com/docs/markdown/customize/skills', invocation: '에이전트가 설명에 따라 관련 Skill을 선택합니다. 공통 /llmwiki 호출을 가정하지 마세요.' },
    mcp: url => ({
      source: 'https://ampcode.com/docs/markdown/customize/mcp', location: '터미널 · Amp 개인 원격 정의',
      value: `amp mcp remote add llmwiki '${url.replace(/'/g, "'\\''")}' --auth oauth --personal`,
      steps: 'Amp가 저장하는 개인 원격 정의를 등록하세요. 이 절차는 로컬 amp.mcpServers 설정과 별개이며 로컬 설정 파일이 필요하지 않습니다. Amp가 엔진에 접근할 수 있는 공개 HTTPS 주소를 사용하세요.',
      login: '같은 개인 원격 정의에 아래 명령으로 로그인하세요.', loginCommand: 'amp mcp remote --personal login llmwiki',
    }),
  },
  {
    id: 'goose', label: 'Goose',
    skill: { target: 'codex', source: 'https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/context-engineering/using-skills.md', invocation: '관련 작업에서 자동으로 불러옵니다. llmwiki Skill을 사용하도록 요청하거나 CLI에서 /skills llmwiki로 호출하세요.' },
    unverifiedMcp: { source: 'https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/using-extensions.md', reason: '공식 문서는 원격 Streamable HTTP와 OAuth 클라이언트 자동 등록을 설명하지만 정확한 로그인 시작 동작은 확인되지 않았습니다. 검증된 MCP OAuth 연결 가이드는 제공하지 않습니다.' },
  },
  {
    id: 'factory-droid', label: 'Factory Droid',
    skill: { target: 'codex', source: 'https://docs.factory.com/harness/skills', invocation: '에이전트가 관련 작업에서 자동 선택합니다. /skills로 관리하거나 /llmwiki로 직접 호출할 수도 있습니다.' },
    mcp: url => ({
      source: 'https://docs.factory.com/harness/mcp', location: '~/.factory/mcp.json',
      value: JSON.stringify({ mcpServers: { llmwiki: { type: 'http', url } } }, null, 2),
      steps: '기존 mcpServers에 병합하세요. 프로젝트 설정은 .factory/mcp.json을 사용합니다.',
      login: 'Droid 대화에서 /mcp를 열고 브라우저 인증 안내에 따라 OAuth 로그인을 완료하세요.',
    }),
  },
  {
    id: 'zed', label: 'Zed',
    skill: { target: 'codex', source: 'https://zed.dev/docs/ai/skills', invocation: '설명에 따라 자동 선택되며 /llmwiki 또는 @skill에서 Skill을 선택할 수도 있습니다.' },
    unverifiedMcp: { source: 'https://zed.dev/docs/ai/mcp', reason: '공식 문서는 원격 MCP와 OAuth를 안내하지만 전송 방식이 Streamable HTTP인지 명시하지 않아 엔진과의 연결 절차를 확정하지 않았습니다. 검증된 MCP OAuth 연결 가이드는 제공하지 않습니다.' },
  },
  {
    id: 'qwen-code', label: 'Qwen Code',
    skill: { target: 'qwen-code', source: 'https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/', invocation: '관련 작업에서 자동 선택됩니다. /skills로 확인하거나 /llmwiki로 직접 호출할 수도 있습니다.' },
    mcp: url => ({
      source: 'https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/', location: '~/.qwen/settings.json',
      value: JSON.stringify({ mcpServers: { llmwiki: { httpUrl: url } } }, null, 2),
      steps: '기존 mcpServers에 병합하세요. 프로젝트 설정은 .qwen/settings.json을 사용합니다. OAuth 자동 발견과 동적 등록을 사용하며 정적 자격 증명을 넣지 않습니다.',
      login: 'OAuth가 필요하면 자동으로 열리는 브라우저에서 인증을 완료하세요. Qwen Code의 /mcp에서 서버 인증 상태를 관리합니다.',
      loginSource: 'https://qwenlm.github.io/qwen-code-docs/en/developers/tools/mcp-server/',
    }),
  },
  {
    id: 'crush', label: 'Crush',
    skill: { target: 'codex', source: 'https://github.com/charmbracelet/crush', invocation: '에이전트가 관련 Skill을 사용하도록 요청하세요. 직접 호출은 user-invocable: true가 설정된 Skill에만 제공되므로 /llmwiki를 가정하지 마세요.' },
    unverifiedMcp: { source: 'https://github.com/charmbracelet/crush/blob/main/docs/config/README.md', reason: '공식 문서는 HTTP와 OAuth 설정을 설명하지만 전송 방식이 Streamable HTTP인지 명시하지 않으며 별도 로그인 동작도 확인되지 않았습니다. 검증된 MCP OAuth 연결 가이드는 제공하지 않습니다.' },
  },
  {
    id: 'claude', label: 'Claude Desktop · claude.ai',
    mcp: url => ({
      source: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp', location: '사용자 지정 커넥터 URL', value: url,
      steps: 'Customize → Connectors → Add custom connector에서 이름 llmwiki와 아래 URL을 입력하세요. Team·Enterprise는 조직 소유자의 커넥터 등록 후 사용자가 개별 연결합니다. Claude Desktop도 Anthropic 클라우드에서 연결하므로 외부 HTTPS 주소가 필요하며 localhost는 사용할 수 없습니다.',
      login: 'Continue에서 발견된 OAuth 설정을 확인하고 Sign in now와 자동 등록(Register automatically)을 선택한 뒤 연결하세요.',
    }),
  },
  {
    id: 'generic', label: '일반 Streamable HTTP',
    mcp: url => ({
      source: 'https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http', location: 'Streamable HTTP 요청 설정',
      value: `POST ${url}\nContent-Type: application/json\nAccept: application/json, text/event-stream\nAuthorization: Bearer <OAuth 액세스 토큰>\nMCP-Protocol-Version: <클라이언트가 협상한 버전>\nMcp-Method: <JSON-RPC method>`,
      steps: 'Streamable HTTP와 OAuth 지원 클라이언트에 URL을 등록하세요. 프로토콜 버전별 헤더는 클라이언트 SDK가 구성하게 하세요. 현재 명세의 tools/call·resources/read·prompts/get은 Mcp-Name 헤더도 요구합니다. 서버는 POST마다 인증하는 stateless JSON 응답 방식이며 GET SSE 구독과 세션 ID를 제공하지 않습니다.',
      login: '메타데이터 발견 → PKCE 브라우저 로그인 → 엔진 OAuth 토큰 발급 → initialize → tools/list 순서로 연결합니다.',
    }),
  },
]
type Check = { name: string; ok: boolean; value: string; error?: string }

function CopyBlock({ value, label }: { value: string; label: string }) {
  async function copy() {
    try { await navigator.clipboard.writeText(value); notify({ title: `${label}을 복사했습니다.`, tone: 'success' }) }
    catch { notify({ title: '복사하지 못했습니다.', description: '내용을 직접 선택해 복사해 주세요.', tone: 'error' }) }
  }
  return <div className="min-w-0 rounded-md border bg-muted/40"><div className="flex h-7 items-center justify-between gap-1.5 border-b px-2"><span className="text-xs text-muted-foreground">{label}</span><Button variant="ghost" size="icon-sm" aria-label={`${label} 복사`} onClick={() => void copy()}><Copy className="size-3.5" /></Button></div><pre className="overflow-x-auto p-2 text-xs"><code>{value}</code></pre></div>
}

function ClientConnectionGuide({ guide, url }: { guide: ClientGuide; url: string }) {
  const config = guide.mcp?.(url)
  if (!config) return <div className="space-y-2">
    <h3 className="flex h-7 items-center gap-1.5 border-b text-label-13 font-semibold">Skill 설치 안내만 제공</h3>
    <p className="text-label-13 leading-5 text-muted-foreground">{guide.unverifiedMcp?.reason}</p>
    {guide.unverifiedMcp && <a href={guide.unverifiedMcp.source} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-label-13 text-link underline underline-offset-4">MCP 지원 공식 문서<ExternalLink className="size-3.5" /></a>}
  </div>
  return <div className="space-y-2">
    <ol className="space-y-2 text-label-13 leading-5">
      <li className="space-y-2"><h3 className="flex h-7 items-center gap-1.5 border-b font-semibold">1. 연결 등록</h3><p className="text-muted-foreground">{config.steps}</p>{url && <CopyBlock value={config.value} label={config.location} />}</li>
      <li className="space-y-2"><h3 className="flex h-7 items-center gap-1.5 border-b font-semibold">2. OAuth 로그인</h3><p className="text-muted-foreground">{config.login}</p>{config.loginCommand && <CopyBlock value={config.loginCommand} label="OAuth 로그인 명령" />}<p className="text-muted-foreground">원격 호스트에서 실행하는 클라이언트는 공식 문서의 콜백 안내를 따르세요.</p></li>
      <li><h3 className="flex h-7 items-center gap-1.5 border-b font-semibold">3. 실제 도구 확인</h3><p className="text-muted-foreground">지식 질문으로 search와 read_note를 실행하고 노트 경로 인용을 확인하세요. write의 queued는 저장 완료가 아닙니다. 반환된 jobId로 get_write_status의 succeeded를 확인하세요.</p></li>
    </ol>
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      <a href={config.source} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-label-13 text-link underline underline-offset-4">클라이언트 공식 문서<ExternalLink className="size-3.5" /></a>
      {config.loginSource && <a href={config.loginSource} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-label-13 text-link underline underline-offset-4">OAuth 명령 공식 문서<ExternalLink className="size-3.5" /></a>}
    </div>
  </div>
}

function SkillInstallGuide({ guide, base }: { guide: ClientGuide; base: string }) {
  const skill = guide.skill
  if (!skill) return null
  return <div className="space-y-2">
    <h3 className="flex h-7 items-center gap-1.5 border-b text-label-13 font-semibold">llmwiki Skill 설치</h3>
    <p className="text-label-13 text-muted-foreground">macOS·Linux 터미널에서 실행하세요. 저장소 복제나 llmwiki CLI 설치 없이 Skill을 설치합니다. MCP 연결·OAuth 로그인은 수행하지 않으며, 검증된 연결 안내가 있는 클라이언트는 위 단계를 별도로 완료하세요.</p>
    {base && <CopyBlock value={`curl -fsSL ${base}/skills/install.sh | sh -s -- install ${skill.target}`} label="Skill 설치 명령" />}
    {skill.target === 'codex' && <p className="text-xs text-muted-foreground">개인 ~/.agents/skills/llmwiki와 프로젝트 .agents/skills/llmwiki는 Codex와 공유하는 디렉터리이므로 설치 대상 codex를 사용합니다.</p>}
    {skill.target === 'cline' && <p className="text-xs text-muted-foreground">개인 설치는 ~/.cline/skills/llmwiki, 프로젝트 설치는 .cline/skills/llmwiki를 사용합니다.</p>}
    {skill.target === 'kiro' && <p className="text-xs text-muted-foreground">개인 설치는 ~/.kiro/skills/llmwiki, 프로젝트 설치는 .kiro/skills/llmwiki를 사용합니다.</p>}
    {skill.target === 'qwen-code' && <p className="text-xs text-muted-foreground">개인 설치는 ~/.qwen/skills/llmwiki, 프로젝트 설치는 .qwen/skills/llmwiki를 사용합니다.</p>}
    <p className="text-xs text-muted-foreground">인수 없이 | sh로 실행하면 대화형으로 클라이언트와 설치 범위를 묻습니다.</p>
    <p className="text-xs text-muted-foreground">프로젝트 설치는 명령 끝에 --project /path/to/project를 추가하세요. {skill.invocation}</p>
    {skill.target === 'hermes' && <CopyBlock value="hermes skills trust /path/to/project" label="Hermes 프로젝트 신뢰" />}
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      <a href={skill.source} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-label-13 text-link underline underline-offset-4">클라이언트 Skill 공식 문서<ExternalLink className="size-3.5" /></a>
      <a href="https://github.com/BitbyteCorp/llmwiki-engine/blob/HEAD/docs/skills.md" target="_blank" rel="noreferrer" className="text-label-13 text-link underline underline-offset-4">Skill 설치 문서</a>
    </div>
  </div>
}

export function McpHelp({ publicUrl }: { publicUrl?: string }) {
  const [origin, setOrigin] = useState('')
  const [client, setClient] = useState(initialClient.id)
  const [checking, setChecking] = useState(false)
  const [checks, setChecks] = useState<Check[]>([])
  const [error, setError] = useState<unknown>(null)
  useEffect(() => { setOrigin(publicUrl || window.location.origin) }, [publicUrl])
  const base = origin.replace(/\/+$/, '')
  const url = base ? `${base}/mcp` : ''
  async function checkConnection() {
    setChecking(true); setChecks([]); setError(null)
    try {
      const serverOrigin = new URL(base).origin
      const results = await Promise.all([{ name: '리소스 메타데이터', path: '/.well-known/oauth-protected-resource', field: 'resource', expected: url }, { name: '인가 서버 메타데이터', path: '/.well-known/oauth-authorization-server', field: 'issuer', expected: base }].map(async entry => {
        try {
          const response = await fetch(`${serverOrigin}${entry.path}`, { headers: { Accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = await response.json() as Record<string, unknown>
          const value = typeof body[entry.field] === 'string' ? body[entry.field] as string : ''
          const ok = value.replace(/\/+$/, '') === entry.expected.replace(/\/+$/, '')
          return { name: entry.name, ok, value: value || '값 없음', ...(!ok ? { error: `PUBLIC_URL을 확인하세요. 예상 주소: ${entry.expected}` } : {}) }
        } catch (cause) { return { name: entry.name, ok: false, value: '조회 실패', error: cause instanceof Error ? cause.message : '네트워크 오류' } }
      }))
      setChecks(results)
    } catch (cause) { setError(cause) }
    finally { setChecking(false) }
  }
  const guide = clients.find(item => item.id === client) ?? initialClient
  return <section aria-labelledby="mcp-heading" className="min-w-0 space-y-2">
    <div className="space-y-2"><h2 id="mcp-heading" className="flex h-7 items-center gap-1.5 border-b text-label-13 font-semibold"><Plug className="size-3.5" />MCP · llmwiki Skill 연결</h2><p className="text-label-13 leading-5 text-muted-foreground">MCP로 같은 지식 저장소를 검색하고 노트·링크·변경 이력을 읽으며, 도니에게 쓰기와 원문 통합을 요청할 수 있습니다. 조회자는 읽기·검색만, 편집자와 관리자는 쓰기·가져오기도 사용할 수 있습니다. 모든 도구에는 현재 역할과 폴더 접근 권한이 적용됩니다.</p><p className="text-label-13 leading-5 text-muted-foreground">클라이언트가 브라우저를 열면 엔진에 로그인하세요. 엔진이 MCP 전용 OAuth 토큰을 발급합니다. API 토큰 탭의 REST 토큰이나 Google 토큰을 MCP 설정에 붙여 넣지 마세요.</p></div>
    {url ? <CopyBlock value={url} label="MCP 서버 주소" /> : <Loading label="서버 주소를 확인하는 중…" />}
    <p className="text-xs text-muted-foreground">{publicUrl ? '서버 PUBLIC_URL을 사용합니다.' : 'PUBLIC_URL이 없으므로 현재 브라우저 origin을 사용합니다.'} 설정 파일의 기존 서버 목록은 유지하고 llmwiki 항목만 병합하세요.</p>
    <div className="space-y-2"><Button variant="outline" disabled={!url || checking} onClick={() => void checkConnection()}><RefreshCw className={`size-3.5 ${checking ? 'animate-spin' : ''}`} />{checking ? '확인 중…' : '연결 확인'}</Button><ErrorNotice error={error} />{checks.length > 0 && <div role="status" className="space-y-2 text-label-13"><div className="divide-y border-y">{checks.map(result => <div key={result.name} className="space-y-1 px-2 py-1.5"><p className={result.ok ? 'font-medium text-success' : 'font-medium text-destructive'}>{result.name} · {result.ok ? '통과' : '실패'}</p><p className="break-all text-xs text-muted-foreground"><span className="font-mono">{result.value}</span>{result.error && <span className="ml-2 text-destructive">{result.error}</span>}</p></div>)}</div><p className="text-xs text-muted-foreground">이 확인은 OAuth 발견 주소만 검사합니다. 실제 로그인과 도구 호출 성공은 클라이언트에서 확인하세요.</p></div>}</div>
    <div className="space-y-2">
      <label htmlFor="mcp-client" className="flex h-7 items-center gap-1.5 border-b text-label-13 font-semibold">클라이언트 연결 가이드</label>
      <select id="mcp-client" value={client} onChange={event => setClient(event.target.value)} className="h-9 w-full rounded-md border bg-background px-3 text-sm">{clients.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      <ClientConnectionGuide guide={guide} url={url} />
    </div>
    <SkillInstallGuide guide={guide} base={base} />
    <div className="space-y-2"><h3 className="flex h-7 items-center gap-1.5 border-b text-label-13 font-semibold">문제 해결</h3><ul className="list-disc divide-y border-b pl-5 text-label-13 text-muted-foreground"><li className="px-2 py-1.5">PUBLIC_URL과 클라이언트 URL, 발견된 resource·issuer가 일치해야 합니다. 프록시 외부 주소와 HTTPS 설정을 확인하세요.</li><li className="px-2 py-1.5">401은 클라이언트에서 OAuth 로그인을 다시 수행하세요. REST API 토큰으로 대체하지 마세요.</li><li className="px-2 py-1.5">조회자의 쓰기 거절은 정상입니다. 편집자·관리자 역할과 대상 폴더 쓰기 권한을 확인하세요.</li><li className="px-2 py-1.5">프록시의 응답 버퍼링과 요청 시간 제한을 확인하세요. 일반 Streamable HTTP 클라이언트는 JSON과 event-stream Accept를 함께 보내야 합니다.</li><li className="px-2 py-1.5">외부 Claude 커넥터에서 localhost는 접근할 수 없습니다. 외부 HTTPS 서버 주소를 사용하세요.</li></ul></div>
  </section>
}
