<?php
/**
 * Minimal PHP client for the GRAM Gateway API.
 *
 * Mirrors what packages/sdk does in TypeScript: canonical signing, a fresh
 * nonce per request, idempotency keys on writes, and constant-time webhook
 * verification.
 *
 * Deliberately dependency-free so it can be dropped into an existing project.
 */

declare(strict_types=1);

final class GramGatewayError extends RuntimeException
{
    public function __construct(
        public readonly string $errorCode,
        string $message,
        public readonly int $status,
        public readonly ?string $requestId = null,
    ) {
        parent::__construct($message);
    }

    /** 5xx and 429 may succeed later; a 4xx will not. */
    public function isRetryable(): bool
    {
        return $this->status >= 500 || $this->status === 429;
    }
}

final class GramGateway
{
    private string $baseUrl;
    private string $apiKey;
    private string $secret;

    public function __construct(string $baseUrl, string $apiKey, private int $timeout = 15)
    {
        $separator = strpos($apiKey, '.');
        if ($separator === false || $separator === 0) {
            throw new InvalidArgumentException('apiKey must be "<prefix>.<secret>"');
        }
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->apiKey  = $apiKey;
        $this->secret  = substr($apiKey, $separator + 1);
    }

    /** @param array<string,mixed> $input */
    public function createInvoice(array $input, ?string $idempotencyKey = null): array
    {
        // Always send a key, so a retry after a timeout cannot create a second
        // invoice (SPEC 1779).
        return $this->request('POST', '/v1/invoices', $input, $idempotencyKey ?? 'inv_' . self::uuid());
    }

    public function getInvoice(string $id): array
    {
        return $this->request('GET', '/v1/invoices/' . rawurlencode($id));
    }

    /** @param array<string,scalar> $query */
    public function listPayments(array $query = []): array
    {
        $target = '/v1/payments';
        if ($query !== []) {
            $target .= '?' . http_build_query($query);
        }
        return $this->request('GET', $target);
    }

    public function getBalances(): array
    {
        return $this->request('GET', '/v1/balances');
    }

    /**
     * Verify an inbound webhook.
     *
     * hash_equals is constant-time: a plain === would leak the signature one
     * byte at a time through timing.
     */
    public static function verifyWebhook(
        string $secret,
        string $rawBody,
        string $timestamp,
        string $signature,
        int $toleranceSeconds = 300,
    ): bool {
        if (!ctype_digit($timestamp)) {
            return false;
        }
        if (abs(time() - (int) $timestamp) > $toleranceSeconds) {
            return false;
        }
        $expected = hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
        return hash_equals($expected, $signature);
    }

    /** @param array<string,mixed>|null $body */
    private function request(
        string $method,
        string $target,
        ?array $body = null,
        ?string $idempotencyKey = null,
    ): array {
        $rawBody   = $body === null ? '' : json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $timestamp = (string) time();
        $nonce     = self::uuid();

        // The target includes the query string; signing only the path would
        // leave filters unauthenticated.
        $canonical = implode("\n", [
            strtoupper($method),
            $target,
            $timestamp,
            $nonce,
            hash('sha256', $rawBody),
        ]);
        $signature = hash_hmac('sha256', $canonical, $this->secret);

        $headers = [
            'content-type: application/json',
            'authorization: Bearer ' . $this->apiKey,
            'x-gateway-timestamp: ' . $timestamp,
            'x-gateway-nonce: ' . $nonce,
            'x-gateway-signature: ' . $signature,
        ];
        if ($idempotencyKey !== null) {
            $headers[] = 'idempotency-key: ' . $idempotencyKey;
        }

        $ch = curl_init($this->baseUrl . $target);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST  => strtoupper($method),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_TIMEOUT        => $this->timeout,
        ]);
        if ($rawBody !== '') {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $rawBody);
        }

        $responseBody = curl_exec($ch);
        if ($responseBody === false) {
            $message = curl_error($ch);
            curl_close($ch);
            // Ambiguous: the request may have been processed. Only retry when
            // an idempotency key makes that safe.
            throw new GramGatewayError('NETWORK_ERROR', $message, 0);
        }
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        $envelope = json_decode((string) $responseBody, true) ?: [];

        if ($status >= 400) {
            $error = $envelope['error'] ?? [];
            throw new GramGatewayError(
                (string) ($error['code'] ?? 'UNKNOWN_ERROR'),
                (string) ($error['message'] ?? "request failed ({$status})"),
                $status,
                isset($error['request_id']) ? (string) $error['request_id'] : null,
            );
        }

        // Unwrap the standard { data, meta } envelope.
        return is_array($envelope['data'] ?? null) ? $envelope['data'] : $envelope;
    }

    private static function uuid(): string
    {
        $bytes    = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
