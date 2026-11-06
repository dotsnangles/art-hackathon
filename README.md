# Art Hackathon — Card Stack

`art-hackathon-query-api`의 검색 API와 `algorithm_team2/prototypes/06-card-stack` 화면을 통합한 독립 프로젝트입니다. 원본 저장소의 코드는 변경하지 않습니다.

## 실행

Node.js 22.9 이상, pnpm 11.25.0을 사용합니다.

```sh
pnpm install
pnpm dev
```

개발 화면: http://127.0.0.1:5173 · API: http://127.0.0.1:3000

최초 구성 시 기존 API 프로젝트의 환경 설정을 루트 `.env`에 복사했습니다. 새 환경에서는 `.env.example`을 `.env`로 복사하고 `SERPAPI_API_KEY`, 선택한 LLM 공급자의 API 키를 입력합니다. 기본 공급자는 Anthropic이며 `LLM_PROVIDER=openai`도 지원합니다. 키는 서버에서만 읽으며 Git과 프론트 빌드에서 제외됩니다. `PORT`는 API/프로덕션 포트(기본 3000), `WEB_PORT`는 개발 화면 포트(기본 5173)입니다. 환경 설정을 변경하면 서버를 재시작합니다.

프로덕션 실행:

```sh
pnpm build
pnpm start
```

http://localhost:3000 에서 카드스택과 API를 같은 서버로 제공합니다. 빌드가 없으면 실행 안내와 함께 종료합니다. 외부 배포는 포함하지 않습니다.

## 검색 동작

- 실제 `GET /search`를 사용합니다. good 최대 10개, awesome 검색어 4개 × 검색어당 최대 2개를 요청합니다. 검색마다 유료 외부 API를 호출합니다.
- good은 원문 검색 결과이며 awesome의 1~4순위는 원문에서 점차 멀어지는 검색어 순위입니다. Google 문서 순위와 구분합니다.
- 카드는 순차 표시되고 선택 시 원문 iframe과 새 탭 링크를 제공합니다. 외부 사이트의 iframe 차단은 우회하지 않습니다.
- 선택한 카드의 제목으로 검색을 이어갑니다. 기존 카드·위치·히스토리는 유지되고 새 스택이 연결됩니다. 검색어 기록을 클릭하면 해당 스택으로 카메라만 이동합니다.
- 새 검색·화면 종료 시 이전 요청을 취소하며, 서버도 연결이 끊어진 요청의 외부 작업을 취소합니다. 오류·빈 결과·시간 제한에 따른 부분 결과를 그대로 표시하고 목데이터로 대체하지 않습니다.
- 가지 화살표는 시각화 규칙에 따른 연결이며 실제 문서 사이의 하이퍼링크를 의미하지 않습니다.
- 분해 기능은 준비 중입니다. `/deconstruct`는 404이며 버튼은 비활성화되어 있습니다.
- 히스토리는 메모리에 보관하므로 새로고침하면 초기화됩니다.

## 구조와 검증

`apps/api`는 검색·LLM 서버와 기존 진단 화면, `apps/web`은 카드스택, `packages`는 공용 graph-contract·lab-kit입니다. 개발 서버는 `/search`를 API로 프록시합니다. 프로덕션 서버는 빌드 화면과 생성된 assets만 공개합니다. 서버 생성 함수의 선택적 `frontendDir` 옵션을 생략하면 기존 API 진단 화면을 유지합니다.

```sh
pnpm check
pnpm test
pnpm build
```

테스트는 외부 API를 대체하며 실제 비용을 발생시키지 않습니다. 목데이터는 명시적인 격리 테스트나 `apiEndpoint: ''`로 지정한 테스트 마운트에서만 사용합니다.

상세 API 규약은 [API_SPEC](apps/api/API_SPEC.md)을 참고하세요.
