/**
 * CubePay Network & TLS Diagnostic Tool
 *
 * Probes DNS, TCP, TLS handshake, and HTTP endpoint accessibility for CubePay
 * endpoints from deployment hosts and CI environments.
 *
 * CRITICAL SECURITY INVARIANT:
 * NEVER logs or outputs API tokens, Authorization headers, or merchant credentials.
 */

import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { URL } from 'node:url';

export interface NetworkDiagnosticResult {
  targetUrl: string;
  hostname: string;
  port: number;
  dns: {
    ipv4: string[];
    ipv6: string[];
    error?: string;
  };
  tcp: {
    ip: string;
    connected: boolean;
    durationMs: number;
    error?: string;
  }[];
  tls: {
    success: boolean;
    durationMs: number;
    protocol?: string | null;
    cipher?: { name: string; standardName?: string; version?: string } | null;
    authorized?: boolean;
    authorizationError?: string | null;
    certificate?: {
      subject: Record<string, unknown>;
      issuer: Record<string, unknown>;
      validFrom: string;
      validTo: string;
      subjectAltName?: string;
    } | null;
    error?: {
      code?: string;
      message: string;
      syscall?: string;
    };
  };
  http?: {
    attempted: boolean;
    status?: number;
    statusText?: string;
    durationMs?: number;
    error?: string;
  };
  classification:
    | 'CONNECTED_SUCCESS'
    | 'REMOTE_TLS_CONNECTION_RESET'
    | 'DNS_RESOLUTION_FAILED'
    | 'TCP_CONNECTION_FAILED'
    | 'TLS_HANDSHAKE_FAILED'
    | 'UNKNOWN_NETWORK_ERROR';
}

export async function diagnoseCubePayNetwork(
  targetUrlString = 'https://cubevps.ir/smspay/api/create-payment.php',
  timeoutMs = 5000,
): Promise<NetworkDiagnosticResult> {
  const url = new URL(targetUrlString);
  const hostname = url.hostname;
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);

  const result: NetworkDiagnosticResult = {
    targetUrl: targetUrlString,
    hostname,
    port,
    dns: { ipv4: [], ipv6: [] },
    tcp: [],
    tls: { success: false, durationMs: 0 },
    classification: 'UNKNOWN_NETWORK_ERROR',
  };

  // 1. DNS Resolution
  try {
    try {
      const ipv4s = await dns.resolve4(hostname);
      result.dns.ipv4 = ipv4s;
    } catch {
      // Ignore if no A record
    }

    try {
      const ipv6s = await dns.resolve6(hostname);
      result.dns.ipv6 = ipv6s;
    } catch {
      // Ignore if no AAAA record
    }

    if (result.dns.ipv4.length === 0 && result.dns.ipv6.length === 0) {
      result.dns.error = 'No IPv4 or IPv6 records resolved';
      result.classification = 'DNS_RESOLUTION_FAILED';
      return result;
    }
  } catch (err: any) {
    result.dns.error = err?.message ?? String(err);
    result.classification = 'DNS_RESOLUTION_FAILED';
    return result;
  }

  // 2. TCP Connectivity Test
  const primaryIp = result.dns.ipv4[0] || result.dns.ipv6[0]!;
  for (const ip of result.dns.ipv4.slice(0, 2)) {
    const tcpStart = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new net.Socket();
        socket.setTimeout(timeoutMs);
        socket.on('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.on('timeout', () => {
          socket.destroy();
          reject(new Error(`TCP connection timeout to ${ip}:${port}`));
        });
        socket.on('error', (err) => {
          socket.destroy();
          reject(err);
        });
        socket.connect(port, ip);
      });

      result.tcp.push({
        ip,
        connected: true,
        durationMs: Date.now() - tcpStart,
      });
    } catch (err: any) {
      result.tcp.push({
        ip,
        connected: false,
        durationMs: Date.now() - tcpStart,
        error: err?.message ?? String(err),
      });
    }
  }

  if (!result.tcp.some((t) => t.connected)) {
    result.classification = 'TCP_CONNECTION_FAILED';
    return result;
  }

  // 3. TLS Handshake Test
  const tlsStart = Date.now();
  try {
    const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const socket = tls.connect(
        {
          host: hostname,
          port,
          servername: hostname,
          timeout: timeoutMs,
          minVersion: 'TLSv1.2',
        },
        () => {
          resolve(socket);
        },
      );

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error(`TLS handshake timeout to ${hostname}:${port}`));
      });

      socket.on('error', (err) => {
        socket.destroy();
        reject(err);
      });
    });

    result.tls.durationMs = Date.now() - tlsStart;
    result.tls.success = true;
    result.tls.protocol = tlsSocket.getProtocol();
    result.tls.cipher = tlsSocket.getCipher();
    result.tls.authorized = tlsSocket.authorized;
    result.tls.authorizationError = tlsSocket.authorizationError?.toString() || null;

    const cert = tlsSocket.getPeerCertificate();
    if (cert && Object.keys(cert).length > 0) {
      result.tls.certificate = {
        subject: cert.subject,
        issuer: cert.issuer,
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        subjectAltName: cert.subjectaltname,
      };
    }

    tlsSocket.destroy();
  } catch (err: any) {
    result.tls.durationMs = Date.now() - tlsStart;
    result.tls.success = false;
    result.tls.error = {
      code: err?.code,
      message: err?.message ?? String(err),
      syscall: err?.syscall,
    };

    if (err?.code === 'ECONNRESET' || err?.message?.includes('socket disconnected') || err?.message?.includes('ECONNRESET')) {
      result.classification = 'REMOTE_TLS_CONNECTION_RESET';
    } else {
      result.classification = 'TLS_HANDSHAKE_FAILED';
    }
    return result;
  }

  // 4. Basic HTTP probe (if TLS succeeded - without credentials)
  const httpStart = Date.now();
  try {
    const res = await fetch(targetUrlString, {
      method: 'GET',
      headers: {
        'user-agent': 'GOLDPAY-Diagnostic/1.0',
        accept: 'application/json, text/plain, */*',
      },
    });

    result.http = {
      attempted: true,
      status: res.status,
      statusText: res.statusText,
      durationMs: Date.now() - httpStart,
    };
    result.classification = 'CONNECTED_SUCCESS';
  } catch (err: any) {
    result.http = {
      attempted: true,
      durationMs: Date.now() - httpStart,
      error: err?.message ?? String(err),
    };
    result.classification = 'CONNECTED_SUCCESS'; // TLS succeeded at transport level
  }

  return result;
}

// CLI entrypoint if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] || 'https://cubevps.ir/smspay/api/create-payment.php';
  diagnoseCubePayNetwork(target)
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
      if (res.classification !== 'CONNECTED_SUCCESS') {
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error('Diagnostic run failed:', err);
      process.exitCode = 1;
    });
}
