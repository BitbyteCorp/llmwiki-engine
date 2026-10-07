# RAG 설계
엔진은 main의 마크다운에서 검색·벡터·태그·링크 인덱스를 파생하고, 짧은 한국어와 의미 검색을 같은 인터페이스에서 제공한다.

## 배경

검색은 Luna의 답변 근거, 기존 노트에 대한 지식 반영, dreaming의 중복 후보 탐색과 웹의 빠른 탐색에 쓰인다. 지식 저장소의 main이 진실 원천이며 SQLite 인덱스는 언제든 재구축할 수 있는 파생물이다. 작업 워크트리의 미머지 변경과 `MEMORY.md`는 검색 대상이 아니다.

## 내용

### 모듈과 저장 구조

`RagModule`은 `KnowledgeModule`을 가져오고 `IndexerService`, `SearchService`, `CatalogService`, `ComparisonService`를 제공·내보낸다. 설정·SQLite·로그는 기존 `CONFIG`, `DB`, `LOGGER` 토큰을 사용한다. `EventsService`는 인덱스 상태 변화를 인증된 사용자에게 전달한다.

마이그레이션 `006_rag.sql`은 청크·임베딩 캐시·위키링크·인덱스 메타데이터를 만든다. `009_rag.sql`은 각 청크에 정규화 태그의 검색 문자열과 JSON 배열, heading anchor, 원문 시작·끝 오프셋, 마지막 수정 커밋의 시간·작성자, 노트 전체의 정규화 해시를 추가한다. 이전 청크를 새 레이아웃으로 재생성하도록 레이아웃 버전을 무효화한다. `chunks_fts`는 trigram, `chunks_terms`는 unicode61 토크나이저를 사용하며 같은 트리거에서 원문 청크와 동기화된다. sqlite-vec의 차원이 스키마에 포함되므로 `chunk_vectors`는 런타임에 생성한다.
`014_link_targets.sql`은 링크의 정규화 키 `target_name`과 원래 표기 `target_text`를 분리한다. 원래 표기는 `#fragment`·`|alias`를 제외한 폴더·대소문자·선택적인 `.md`를 보존한다. 같은 정규화 키가 여러 번 나오면 첫 표기를 유지한다. 마이그레이션은 레이아웃 버전을 무효화하므로 HEAD가 같아도 다음 동기화가 원문에서 링크를 다시 추출한다.

경로가 `wiki/`, `journal/`, `raw/`로 시작하면 종류는 각각 `wiki`, `journal`, `raw`이고 나머지는 `other`다. 인덱스에는 main에 추적된 마크다운만 들어간다.

### 청크, 태그와 앵커

frontmatter를 분리하고 H1~H6 제목을 기준으로 청크를 만든다. 첫 H1과 앞 문맥은 함께 유지한다. 긴 섹션은 약 800토큰 이하로 나누고 문단·문장·공백 경계를 우선한다. 이웃 청크에는 최대 약 80토큰의 작은 겹침을 둬 경계에 걸친 문장을 보존한다. ASCII 네 글자 또는 비ASCII 코드 포인트 한 글자를 한 토큰으로 근사한다. `source_start`와 `source_end`는 frontmatter를 포함한 원문 마크다운의 UTF-16 반열린 범위이며, `markdown.slice(start,end)`가 청크 본문과 같다. 겹침 때문에 청크들을 단순 연결하면 원문이 되지 않는다.

제목은 frontmatter의 `title`, 첫 H1, 확장자를 뺀 파일명 순서로 정한다. 임베딩 입력은 `제목 > 섹션 경로`와 태그를 문맥 헤더로 붙인다. 태그는 NFKC 정규화, 소문자 변환, 맨 앞 `#` 제거, 공백의 하이픈 치환을 적용하고 중복을 제거한다. 청크마다 저장하지만 태그 facet의 count는 청크 수가 아니라 서로 다른 노트 수다.

앵커는 웹과 같은 `remark-gfm`·`remark-math`·`rehype-slug` 처리 결과와 위키링크의 표시 이름을 사용한다. `rehype-slug`가 사용하는 github-slugger의 노트별 중복 카운터를 공유하므로 동일 제목은 `heading`, `heading-1`처럼 구분된다. 첫 H1, H4~H6, setext heading, 인라인 마크다운과 엔티티도 중복 카운터에 영향을 준다. 코드 펜스 안의 제목은 앵커가 아니다. 청크는 해당 섹션 제목의 앵커를 가지며 제목이 없는 문맥은 `null`이다.

### 어휘 검색과 한국어

원문 질의 전체를 리터럴로 인용한 trigram 부분 문자열 채널을 유지한다. 3글자 이상 부분 문자열은 `저장소는`에서 `저장소`를 찾는다. FTS 연산자를 입력해도 검색 문법으로 실행하지 않는다.

별도의 term 채널은 질의를 최대 20개의 Unicode 문자·숫자 단어로 나누고 unicode61 접두어 검색을 수행한다. 먼저 모든 term의 AND를 검색하고 결과가 없을 때만 OR로 완화한다. 따라서 서로 떨어진 `storage`와 `policy`도 하나의 청크에서 찾는다. 질의에 1~2글자 term이 있으면 term 채널을 LIKE 부분 문자열로 바꿔 `저장`, `책`처럼 짧은 한국어도 API 키 없이 찾는다. SQL 와일드카드는 리터럴로 이스케이프한다.

두 어휘 채널의 필드 가중치는 제목 10, heading 6, 태그 3, 본문 1이다. 제목이 같은 단어를 담는 노트가 본문에만 단어를 가진 노트보다 우선한다. 긴 문서의 반복 청크가 관련성이 높은 짧은 문서를 누르지 않도록 노트 점수에는 제한된 추가 증거만 보탠다.

### 융합, 옵션과 비용

각 기본 어휘 채널과 벡터 채널에서 최대 200개의 필터 적용 후보를 가져온다. 청크 점수는 RRF `1/(60+rank)`로 합친다. RRF가 BM25의 절대 크기를 지우므로 원래 질의 term이 제목·heading·태그에 포함된 비율에 각각 0.5·0.25·0.1을 곱한 값 중 최대값을 택하고, `1+최대값`을 청크 점수에 곱한다. 제목의 강한 근거가 반복 본문에 밀리지 않게 하는 제한된 필드 보정이다. 노트 점수는 최고 청크 점수에 다음 세 청크의 점수를 각각 0.1, 0.05, 0.025배로 더하되 추가 합은 최고 점수의 20%로 제한한다. 무제한 청크 합산을 제거하여 노트 길이가 순위를 지배하지 않게 한다. 동일 점수의 노트는 경로로 결정적으로 정렬한다. `related`는 직접 검색된 노트의 양방향 1-hop 링크 맥락이며 링크 자체를 검색 hit로 승격하거나 의미 이웃으로 간주하지 않는다. 링크 그래프 점수 보정은 사용하지 않는다.

`SEARCH_EXPAND=off|llm`의 기본값은 `off`다. `llm`은 기존 OpenAI Responses 클라이언트 설정과 Luna 모델을 사용해 별칭·한국어↔영어 번역 질의를 최대 3개 생성한다. 입력은 500자, 별칭은 각각 100자, 출력은 160토큰으로 제한하며 각 확장 채널의 RRF 가중치는 0.35다. 원래 질의 증거가 확장보다 강하다. 서비스별 최대 200개, 10분 캐시를 사용한다.

`SEARCH_RERANK=off|llm`의 기본값도 `off`다. `llm`은 융합 상위 최대 12개 노트의 제목·짧은 excerpt만 보내 순서를 정한다. 반환값은 기존 후보 인덱스의 완전한 순열이어야 하며 새 노트를 만들어 넣지 않는다. 출력은 180토큰으로 제한한다. 순서에 맞춰 기존 점수 스케일을 재배정한다.

두 옵션은 각각 검색마다 Responses 요청 한 번을 추가하므로 비용·지연과 원문 일부의 외부 전송이 증가한다. 각 요청은 5초 제한이며 자동 재시도를 하지 않는다. 확장과 재정렬을 함께 켜면 순차 실행이므로 최대 약 10초가 추가될 수 있다. 키 누락, API 오류, 잘못된 JSON·순열은 원래 질의 또는 융합 순위로 복구한다. 벡터 질의 임베딩은 이 옵션과 별도로 호출한다. 캐시와 cursor는 프로세스 로컬이며 재시작하면 사라진다.

### 검색 결과와 필터

`SearchService.search(query,opts)`는 Luna·MCP·dreaming을 위해 `SearchHit[]`를 계속 반환한다. `SearchService.query(query,opts)`는 `{ mode,degraded,hits,nextCursor }`를 반환한다. 기본 limit은 내부 서비스·HTTP·MCP 모두 **20**이며 1~100의 정수다. 빈 내부 질의는 빈 배열이며 HTTP의 빈 `q`는 400이다.

hit의 필드는 `path`, `title`, `kind`, `score`, `heading`, `anchor`, `excerpt`, `highlights`, `tags`, `updatedAt`, `snippet`, `related`다. `excerpt`는 첫 매칭 주변의 약 260자 본문이며 잘린 양끝은 `…`로 표시한다. `highlights`의 `[start,end]`는 excerpt의 UTF-16 반열린 범위다. `snippet`은 기존 내부 호출자의 호환을 위해 가장 좋은 청크 본문 전체를 유지한다. `heading`은 섹션 경로이며 `anchor`는 웹의 heading id다. `updatedAt`과 작성자 필터는 frontmatter 날짜가 아니라 마지막으로 해당 노트를 수정한 git 커밋에서 인덱싱한다. 시간이 없는 경우 `updatedAt:null`이다.

`SearchFilters`는 `kinds`, `folder`, `tags`, `from`, `to`, `author`를 제공한다. folder는 폴더 경로와 `/` 경계를 가진 접두어다. tags는 정규화 후 모든 태그를 만족해야 한다. from/to는 ISO 날짜 또는 offset을 포함한 날짜·시간이며 하한은 포함한다. 날짜만 지정한 to는 해당 UTC 날짜 전체를 포함하고 날짜·시간 to는 정확한 상한을 포함한다. author는 마지막 수정 커밋의 이름·이메일을 대소문자 비구분 부분 문자열로 찾는다. 모든 필터는 어휘 후보 LIMIT와 벡터 최근접 k 선택 **이전**에 적용하므로 다른 폴더의 높은 점수가 선택을 굶기지 않는다.

cursor는 처음 검색의 정렬된 결과 스냅샷과 오프셋을 가리킨다. 후속 페이지는 인덱스 변경·임베딩 응답·재정렬에 영향받지 않는다. 원래 q와 필터를 그대로 보내야 하며 limit은 바꿀 수 있다. 스냅샷은 서비스별 최대 200개를 5분간 보관한다. 만료·재시작·다른 q/필터의 cursor는 `400 invalid_search`다. `nextCursor:null`이면 마지막 페이지다.

인증된 읽기는 [폴더별 접근 제어](access-control.md)의 SQL 읽기 조건도 후보 LIMIT와 벡터 top-k 전에 적용한다. 숨겨진 결과를 페이지 생성 뒤 제거하지 않으므로 제한된 폴더의 높은 순위가 읽을 수 있는 결과를 굶기지 않는다. 자동 완성·유사도·중복·관련 노트는 같은 사용자 정책을 따르고 그래프 노드·간선과 태그 count에는 숨겨진 노트를 포함하지 않는다.

사용자 검색 커서는 사용자 ID·현재 역할·ACL 정책 버전에 결합한다. 다른 사용자에게 넘긴 커서나 규칙 변경 뒤의 커서는 유효하지 않으며 처음부터 다시 검색한다. dreaming처럼 명시적인 시스템 호출만 사용자 정책 없이 검색한다.

확장·임베딩·재정렬을 기다리는 중 정책 버전이 바뀌면 이전에 허용된 발췌를 새 정책으로 재분류하지 않는다. 재정렬 공급자에게 발췌를 보내기 전과 응답·스냅샷을 확정하기 전에 정책을 확인하고 변경되었으면 `400 invalid_search`로 결과를 폐기한다. 호출자는 새 검색을 제출한다.

### HTTP 읽기 인터페이스

모든 경로는 세션 또는 read scope bearer 인증과 viewer 이상 역할을 요구한다. 입력 검증 실패는 기존 `{ error:{code,message} }`의 `400 invalid_input`이다.

| 경로 | 질의 | 응답 |
|---|---|---|
| `GET /api/search` | `q,limit,cursor,folder,tags=a,b,from,to,author` | `{mode,degraded,hits,nextCursor}` |
| `GET /api/search/suggest` | `q` 생략 시 빈 문자열 | `[{path,title}]`, 제목·경로 접두어 우선, 최대 20개 |
| `GET /api/search/similar` | `path`, `limit` 기본 20 | `[{path,title,score}]` |
| `GET /api/search/duplicates` | `limit` 기본 20 | `[{left:{path,title},right:{path,title},score,reason,passages:[{left:{anchor,excerpt},right:{anchor,excerpt}}]}]` |
| `GET /api/links` | `path` 필수 | `{outgoing:[{path,title}],backlinks:[{path,title}],unresolved:string[]}` |
| `GET /api/graph` | `path` 선택, `depth` 1~5 기본 1 | `{nodes:[{path,title,tags}],edges:[{from,to}]}` |
| `GET /api/tags` | 없음 | `[{tag,count}]` |
| `GET /api/tags/notes` | `tag` 필수 | `[{path,title}]` |

links는 별칭에 의한 중복을 제거하며 삭제·미해결 대상은 unresolved로 남긴다. unresolved는 정규화된 basename이 아니라 원래 대상 표기이며 `[[Archive/NewDraft.MD#절|별칭]]`은 `Archive/NewDraft.MD`로 반환된다. graph는 양방향 링크를 따라 이웃을 탐색하되 간선의 원래 방향을 유지한다. path를 생략하면 고립 노트를 포함한 전체 그래프를 반환한다. 존재하지 않거나 모호한 링크 대상은 노드·간선에서 제외한다.

`NoteTargetResolver`는 `/api/notes/resolve`와 인덱서·catalog가 함께 쓰는 해석 규칙이다. 공백·fragment·alias·마지막 `.md`를 제거하고 대소문자를 무시한다. 폴더가 있는 대상은 전체 경로로, 폴더가 없는 대상은 basename으로 비교한다. 후보가 정확히 하나일 때만 연결하고 여러 개면 `path:null`과 정렬된 candidates를 반환한다. 대상이 없는 notes resolve 요청은 기존 404를 유지한다.

사용자 읽기에서는 ACL로 후보를 먼저 필터링한다. 전체 저장소에서는 모호하지만 해당 사용자가 볼 수 있는 후보가 하나인 링크는 catalog가 같은 해석기로 다시 연결한다. outgoing·backlinks·graph가 모두 이 사용자별 간선을 공유하므로 렌더러와 일치한다. 이미 연결된 숨겨진 대상은 출력하지 않으며 unresolved로 바꾸어 노출하지 않는다. 숨겨진 원본 노트의 backlink도 제외한다.

similar는 준비된 청크 벡터의 노트별 평균을 정규화하여 cosine 유사도를 비교한다. 자기 자신을 제외하며 링크만으로 이웃을 추가하지 않는다. 저장된 모델·차원이 맞는 벡터는 API 키 없이도 사용할 수 있다. 벡터 설정이 맞지 않으면 빈 배열이다. duplicates는 NFKC·공백 정규화된 노트 해시의 정확한 일치 또는 노트 cosine 0.98 이상을 후보로 반환한다. 정확한 중복은 키·벡터가 없어도 찾는다. 의미 중복은 가장 비슷한 청크 쌍의 앵커와 최대 240자 발췌를 제공한다. 어떤 노트도 수정하지 않으며 삭제·병합 결정은 사용자에게 맡긴다.

### catalog 스냅샷과 요청별 접근 투영

링크·그래프 catalog는 사용자별 응답이 아니라 ACL 적용 전 노트·링크 후보와 입출력 인접 색인을 담은 스냅샷 하나를 보관한다. 현재 `indexed_sha`와 `index_meta.catalog_revision`의 쌍을 키로 사용하며 과거 SHA별 스냅샷을 쌓지 않는다. 경로를 지정한 links와 graph 조회는 인접 색인을 따라가므로 매번 전체 노트·간선을 스캔하지 않는다. SQLite 읽기 인덱스의 구성은 [읽기 성능](performance.md#sqlite-설정과-읽기-인덱스)에 기록한다.

인덱서는 색인 반영 트랜잭션 안에서 `catalog_revision`을 증가시킨다. HEAD가 같아도 전체·레이아웃 재구축과 대기 벡터 재시도는 새 스냅샷을 만들 수 있다. 첫 색인 전처럼 revision이 없는 직접 DB fixture에만 `total_changes()`를 신선도 기준으로 사용한다. 초기화된 catalog는 인증·토큰·ACL 기록처럼 색인과 무관한 DB 변경 때문에 원천 스냅샷을 버리지 않는다.

각 요청은 현재 사용자의 `AclService.readPredicate()`를 새로 얻고 같은 동기 요청 안에서만 경로 읽기 판정과 링크 목적지 해석을 재사용한다. 이 정책 스냅샷을 요청 간 공유하거나 `await`를 가로질러 보관하지 않는다. 사용자별 링크 해석은 앞 절의 [읽기 권한 규칙](#http-읽기-인터페이스)을 그대로 적용한다. 반환 요약 객체·노드의 태그 배열·간선도 새로 만들어 호출자의 수정이 이후 요청을 오염시키지 않게 한다.

### 신선도와 정직한 저하 모드

`IndexerService.onModuleInit()`은 벡터 스키마와 레이아웃을 확인하고 주기 검사기를 시작한다. 서버는 기존 초기 `syncToHead()`를 실행하며 main 머지 후 호출도 유지한다. `INDEX_POLL_SECONDS`의 기본값은 60초다. 외부에서 main이 진행해도 HEAD와 저장 SHA를 비교하여 동기화하고 대기 벡터를 재시도한다. 종료할 때 타이머를 해제하고 진행 중 동기화를 기다린다.

증분 동기화는 이전 SHA와 HEAD 사이의 이름·삭제·변경을 확인한다. 내용·제목·태그·heading을 포함한 임베딩 입력 SHA-256, 모델, 차원으로 캐시를 재사용한다. 동일 설정의 전체 재인덱싱이나 내용이 같은 이동도 캐시를 활용한다. 삭제·이동·추가 후 모든 저장 링크를 공유 해석기로 다시 해석한다. 폴더가 지정된 대상은 다른 폴더의 같은 basename에 연결하지 않으며, basename 충돌은 임의의 첫 경로를 선택하지 않고 미해결로 남긴다.

동기화와 재구축은 직렬화하며 청크·벡터·링크·메타데이터를 트랜잭션으로 반영한다. 임베딩 API가 실패해도 최신 어휘·링크 인덱스는 반영하고 벡터를 대기 상태로 남긴다. 마지막 오류를 기록하므로 lexical SHA가 최신이어도 벡터 준비 여부를 성공으로 숨기지 않는다. API 키를 나중에 설정하면 HEAD 변화 없이도 대기 벡터를 채운다.

`status()`는 `{ indexedSha,headSha,syncing,lastSyncAt,lastError,pendingVectors,embedding:{configured,model,dimensions,ready} }`를 반환하는 비동기 메서드다. 모델·차원을 바꾸면 `lastError:'vector_mismatch'`로 보고하고 기존 벡터 테이블을 새 차원으로 만든 뒤 대기 상태로 표시한다. 명시적 `reindex({full:true})` 또는 `llmwiki reindex --full`의 성공한 전체 재구축이 mismatch를 해소한다. `llmwiki reindex`와 `reindex({full:false})`는 증분 동기화다. `index.updated` 이벤트는 `{type:'index.updated',sha,status:'syncing'|'ready'|'error'}`이며 대상은 모든 인증 사용자다.

검색의 mode는 실제 벡터 채널까지 실행하면 `hybrid`, 어휘만 실행하면 `keyword`다. degraded는 정상 시 null이며 다음 이유를 구분한다.

| 이유 | 의미 |
|---|---|
| `no_api_key` | 질의 임베딩 키가 없어 어휘만 검색한다. |
| `embedding_error` | 질의 임베딩 API 요청이 실패하여 어휘 결과를 보존한다. |
| `vector_mismatch` | 저장 모델·차원·스키마가 현재 설정과 다르거나 벡터 검색이 실패한다. |
| `index_stale` | HEAD가 indexed SHA보다 진행했거나 대기 벡터가 있어 완전한 하이브리드를 제공할 수 없다. |

키 누락을 먼저, 설정 불일치를 다음으로 보고하며 그 다음 신선도를 확인한다. 임베딩·벡터 실패는 검색 호출자에게 전파하지 않는다. 저하 상태에서도 필터, 짧은 한국어, tag 검색, cursor를 제공한다.

### 평가와 순위 선택

`src/rag/evaluation-fixtures.ts`는 한국어·영어 노트 9개와 질의 8개의 관련 노트 집합을 담는다. `test/rag/retrieval-upgrade.test.ts`는 짧은 한국어, 떨어진 다중 term, 태그, 폴더·시간·작성자, 긴 노트 청킹을 실제 git 저장소·SQLite와 결정적 fake OpenAI 임베딩으로 평가하고 Recall@3와 MRR을 출력한다. fake 임베딩은 텍스트 해시 기반이므로 실제 모델의 의미 품질을 측정하는 자료가 아니라 채널 융합과 실패 복구의 재현 가능한 회귀 자료다. 검증한 어휘·하이브리드 모드의 Recall@3와 MRR은 각각 1.0이다.

최고 청크와 제한된 추가 증거를 사용하는 이유는 긴 노트의 반복 청크가 점수 합산만으로 상위에 고정되는 편향을 피하기 위해서다. 필드 보정 전 평가에서는 Recall@3가 1.0이어도 MRR이 0.9375였고, `durable storage`의 반복 광고 노트가 실제 영속성 설명 노트보다 높았다. 제목 근거를 제한적으로 보정한 후 두 모드 모두 MRR이 1.0이 되었으며 관련 설명 노트가 먼저 나온다. 두 어휘 채널은 짧은 한국어·떨어진 term의 recall을 보완한다. LLM 옵션은 기본 평가·운영 경로에서 꺼 두며 필요할 때만 비용을 감수하고 켠다.

### 검토한 대안

OpenAI 호스티드 file_search는 지식 복제와 별도 동기화가 필요하고 MCP까지 외부 스토어에 묶이므로 사용하지 않는다. PostgreSQL 전환 기준과 sqlite-vec의 위험은 아키텍처 문서에서 다룬다. Qdrant는 컨테이너 하나 요구사항과 맞지 않는다.

## 관련 문서

- [엔진 구성](architecture.md)은 SQLite·sqlite-vec 선택과 실행 구조를 설명한다.
- [지식 저장소](knowledge-repository.md)는 검색 원문과 main의 역할을 설명한다.
- [Luna](luna.md)는 검색 결과를 쓰는 모델과 임베딩의 역할을 설명한다.
- [MCP](mcp.md)와 [웹 버전](web.md)은 사용자 검색 인터페이스를 설명한다.
- [쓰기 흐름](write-flow.md)과 [dreaming](dreaming.md)은 main 머지와 지식 정리 절차를 설명한다.
- [읽기 성능과 캐시 경계](performance.md)는 SQLite 읽기 인덱스, git·HTTP 캐시와 렌더링 비용을 설명한다.
