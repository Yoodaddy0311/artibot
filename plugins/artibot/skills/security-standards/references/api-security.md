# API Security (심화 가이드)

> `security-standards` 스킬의 참조 문서. API 보안 설계, 인증/인가, Rate Limiting, CORS 모범 사례를 다룬다.

## 1. 인증 패턴

### JWT (JSON Web Token)

```javascript
import jwt from 'jsonwebtoken';

// 토큰 발급
function issueToken(userId, roles) {
  return jwt.sign(
    { sub: userId, roles, iat: Math.floor(Date.now() / 1000) },
    process.env.JWT_SECRET,
    {
      expiresIn: '15m',           // Access token: 짧은 수명
      algorithm: 'RS256',         // 비대칭 키 권장
      issuer: 'api.example.com',
      audience: 'app.example.com',
    }
  );
}

// 토큰 검증 미들웨어
function verifyToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }

  try {
    req.user = jwt.verify(header.slice(7), process.env.JWT_PUBLIC_KEY, {
      algorithms: ['RS256'],
      issuer: 'api.example.com',
      audience: 'app.example.com',
    });
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
```

**JWT 보안 체크리스트**:
- Access Token 수명: 15분 이내
- Refresh Token 수명: 7일, 단일 사용(rotation)
- 알고리즘: RS256 (비대칭) 또는 ES256, HS256 지양
- `none` 알고리즘 거부 (반드시 algorithms 옵션 명시)
- 민감 데이터를 페이로드에 포함하지 않음

### OAuth2 플로우 선택

| 플로우 | 클라이언트 유형 | 사용 사례 |
|--------|--------------|----------|
| Authorization Code + PKCE | SPA, 모바일 | 사용자 대면 앱 (권장) |
| Client Credentials | 서버 간 통신 | 백엔드 서비스 |
| Device Code | CLI, TV, IoT | 브라우저 없는 기기 |

**절대 사용 금지**: Implicit Flow (토큰이 URL fragment에 노출)

### API Key Rotation

```javascript
// 키 로테이션 전략: 이중 키 활성
const VALID_API_KEYS = new Set([
  process.env.API_KEY_CURRENT,   // 현재 활성 키
  process.env.API_KEY_PREVIOUS,  // 이전 키 (유예 기간)
]);

function validateApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || !VALID_API_KEYS.has(key)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  if (key === process.env.API_KEY_PREVIOUS) {
    res.setHeader('X-API-Key-Deprecated', 'true');
    // 로테이션 경고 로그
  }

  next();
}
```

**로테이션 절차**:
1. 새 키 생성 → `API_KEY_CURRENT`에 설정
2. 기존 키 → `API_KEY_PREVIOUS`로 이동
3. 유예 기간 (7-30일) 후 이전 키 삭제
4. 클라이언트에 마이그레이션 알림

## 2. Rate Limiting & Throttling

### 구현 패턴

```javascript
import rateLimit from 'express-rate-limit';

// 전역 Rate Limit
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15분
  max: 100,                    // 윈도우당 최대 요청
  standardHeaders: true,       // RateLimit-* 헤더 포함
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: res.getHeader('Retry-After'),
    });
  },
});

// 엔드포인트별 Rate Limit
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,                      // 로그인: 15분에 5회
  skipSuccessfulRequests: true, // 성공한 요청은 카운트 제외
});

app.use('/api/', globalLimiter);
app.post('/api/auth/login', loginLimiter, loginHandler);
```

**Rate Limit 전략**:
| 엔드포인트 | 윈도우 | 최대 요청 | 키 |
|-----------|--------|----------|-----|
| 공개 API | 15분 | 100 | IP |
| 인증된 API | 1분 | 60 | User ID |
| 로그인 | 15분 | 5 | IP + Email |
| 비밀번호 재설정 | 1시간 | 3 | Email |
| 파일 업로드 | 1시간 | 10 | User ID |

### 분산 환경 Rate Limiting

```javascript
import { RedisStore } from 'rate-limit-redis';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

const distributedLimiter = rateLimit({
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
  windowMs: 60 * 1000,
  max: 60,
});
```

## 3. Input Validation & Output Encoding

### Request Validation

```javascript
import { z } from 'zod';

const createUserSchema = z.object({
  email: z.string().email().max(255),
  name: z.string().min(1).max(100).regex(/^[\w\s\-]+$/),
  age: z.number().int().min(0).max(150).optional(),
  role: z.enum(['user', 'admin']).default('user'),
});

function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues.map(i => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    req.body = result.data;  // 검증된 데이터로 교체
    next();
  };
}

app.post('/api/users', validateBody(createUserSchema), createUser);
```

### Output Encoding

```javascript
// JSON 응답 — 민감 필드 제거
function sanitizeUser(user) {
  const { password, refreshToken, ...safe } = user;
  return safe;
}

// 에러 응답 — 내부 정보 차단
function errorHandler(err, req, res, next) {
  const isProduction = process.env.NODE_ENV === 'production';
  res.status(err.status ?? 500).json({
    error: isProduction ? 'Internal server error' : err.message,
    // stack trace는 프로덕션에서 절대 노출하지 않음
  });
}
```

## 4. CORS 설정

```javascript
import cors from 'cors';

const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = [
      'https://app.example.com',
      'https://admin.example.com',
    ];

    // origin이 없는 경우: 서버 간 요청, 모바일 앱
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  exposedHeaders: ['X-RateLimit-Remaining', 'X-Request-ID'],
  credentials: true,      // 쿠키 전송 허용
  maxAge: 86400,           // Preflight 캐시: 24시간
};

app.use(cors(corsOptions));
```

**CORS 안티패턴**:
- `origin: '*'` + `credentials: true` → 브라우저가 거부함
- `origin: '*'` → 인증이 필요한 API에 사용 금지
- 동적 origin 반영(reflect) → 허용 목록 없이 요청 origin을 그대로 반환하면 위험

## 5. API Versioning 보안 고려

```
# URL 패스 기반 (권장)
GET /api/v1/users
GET /api/v2/users

# 헤더 기반
GET /api/users
Accept: application/vnd.example.v2+json
```

**보안 고려사항**:
- 이전 버전도 보안 패치 유지 (EOL까지)
- 지원 종료(EOL) 버전은 명시적으로 `410 Gone` 반환
- 버전별 Rate Limit 독립 적용
- 새 버전 출시 시 이전 버전의 알려진 취약점 검토

## Quick Reference

| 위협 | 대응 | 우선순위 |
|------|------|---------|
| 토큰 탈취 | 짧은 수명 + Refresh Rotation | Critical |
| Brute Force | Rate Limiting + 계정 잠금 | Critical |
| 과도한 데이터 노출 | Output 필터링 + 필드 선택 | High |
| CORS 우회 | 허용 목록 기반 origin 검증 | High |
| API 남용 | Rate Limit + API Key + 모니터링 | High |
| 구 버전 취약점 | EOL 정책 + 강제 마이그레이션 | Medium |
