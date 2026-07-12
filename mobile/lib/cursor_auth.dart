import 'dart:convert';

import 'package:http/http.dart' as http;

class CursorAuthResult {
  const CursorAuthResult({required this.ok, this.token, this.error});

  final bool ok;
  final String? token;
  final String? error;
}

/// Pairs with a CursorRemote relay using a one-time code.
/// Returns a session token (Bearer) on success.
Future<CursorAuthResult> pairWithCursorRemote({
  required Uri baseUri,
  required String code,
}) async {
  final pairUri = baseUri.replace(path: '/api/pair', query: '');
  try {
    final headers = <String, String>{
      'Content-Type': 'application/json',
    };
    if (baseUri.host.contains('ngrok')) {
      headers['ngrok-skip-browser-warning'] = 'true';
    }

    final res = await http
        .post(
          pairUri,
          headers: headers,
          body: jsonEncode({'code': code.trim()}),
        )
        .timeout(const Duration(seconds: 10));

    if (res.statusCode == 200) {
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final token = body['token'] as String?;
      if (token == null || token.isEmpty) {
        return const CursorAuthResult(ok: false, error: 'No token in response');
      }
      return CursorAuthResult(ok: true, token: token);
    }
    if (res.statusCode == 404 || res.statusCode == 410) {
      return const CursorAuthResult(
        ok: false,
        error: 'Invalid or expired code. Generate a new one in Cursor.',
      );
    }
    if (res.statusCode == 429) {
      return const CursorAuthResult(
        ok: false,
        error: 'Too many attempts. Wait a moment and try again.',
      );
    }
    return CursorAuthResult(ok: false, error: 'Pairing failed (${res.statusCode})');
  } catch (e) {
    return CursorAuthResult(ok: false, error: 'Cannot reach server: $e');
  }
}

/// Legacy login kept for backward compatibility with older servers.
Future<CursorAuthResult> loginCursorRemote({
  required Uri baseUri,
  required String password,
}) async {
  final loginUri = baseUri.replace(path: '/api/login', query: '');
  try {
    if (password.isEmpty) {
      final healthHeaders = <String, String>{};
      if (baseUri.host.contains('ngrok')) {
        healthHeaders['ngrok-skip-browser-warning'] = 'true';
      }
      final health = await http
          .get(
            baseUri.replace(path: '/health', query: ''),
            headers: healthHeaders,
          )
          .timeout(const Duration(seconds: 8));
      if (health.statusCode == 200) {
        final body = jsonDecode(health.body) as Map<String, dynamic>;
        if (body['authRequired'] == false) {
          return const CursorAuthResult(ok: true, token: 'no-auth');
        }
      }
      return const CursorAuthResult(ok: false, error: 'Password required');
    }

    final headers = <String, String>{
      'Content-Type': 'application/json',
    };
    if (baseUri.host.contains('ngrok')) {
      headers['ngrok-skip-browser-warning'] = 'true';
    }

    final res = await http
        .post(
          loginUri,
          headers: headers,
          body: jsonEncode({'password': password}),
        )
        .timeout(const Duration(seconds: 10));

    if (res.statusCode == 200) {
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final token = body['token'] as String?;
      if (token == null || token.isEmpty) {
        return const CursorAuthResult(ok: false, error: 'No token in response');
      }
      return CursorAuthResult(ok: true, token: token);
    }
    if (res.statusCode == 401) {
      return const CursorAuthResult(ok: false, error: 'Invalid password');
    }
    if (res.statusCode == 429) {
      return const CursorAuthResult(
        ok: false,
        error: 'Too many attempts — wait and retry',
      );
    }
    return CursorAuthResult(ok: false, error: 'Login failed (${res.statusCode})');
  } catch (e) {
    return CursorAuthResult(ok: false, error: 'Cannot reach server: $e');
  }
}
