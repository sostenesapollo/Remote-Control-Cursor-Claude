import 'dart:convert';

import 'package:http/http.dart' as http;

class CursorAuthResult {
  const CursorAuthResult({required this.ok, this.token, this.error});

  final bool ok;
  final String? token;
  final String? error;
}

/// Logs into CursorRemote and returns a session token (Bearer).
Future<CursorAuthResult> loginCursorRemote({
  required Uri baseUri,
  required String password,
}) async {
  final loginUri = baseUri.replace(path: '/api/login', query: '');
  try {
    if (password.isEmpty) {
      // Server may have auth disabled — probe health.
      final health = await http
          .get(baseUri.replace(path: '/health', query: ''))
          .timeout(const Duration(seconds: 8));
      if (health.statusCode == 200) {
        final body = jsonDecode(health.body) as Map<String, dynamic>;
        if (body['authRequired'] == false) {
          return const CursorAuthResult(ok: true, token: 'no-auth');
        }
      }
      return const CursorAuthResult(ok: false, error: 'Password required');
    }

    final res = await http
        .post(
          loginUri,
          headers: {'Content-Type': 'application/json'},
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
      return const CursorAuthResult(ok: false, error: 'Too many attempts — wait and retry');
    }
    return CursorAuthResult(ok: false, error: 'Login failed (${res.statusCode})');
  } catch (e) {
    return CursorAuthResult(ok: false, error: 'Cannot reach server: $e');
  }
}
