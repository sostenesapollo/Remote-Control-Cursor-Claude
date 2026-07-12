import 'package:shared_preferences/shared_preferences.dart';

class AppSettings {
  AppSettings({
    this.cursorBaseUrl = '',
    this.cursorToken = '',
    this.claudeUrl = 'https://claude.ai/code',
  });

  String cursorBaseUrl;
  String cursorToken;
  String claudeUrl;

  static const _kCursorUrl = 'cursor_base_url';
  static const _kCursorToken = 'cursor_token';
  static const _kClaudeUrl = 'claude_url';

  bool get isPaired =>
      cursorBaseUrl.trim().isNotEmpty && cursorToken.trim().isNotEmpty;

  Uri? get cursorUri {
    final raw = cursorBaseUrl.trim();
    if (raw.isEmpty) return null;
    final withScheme = raw.contains('://') ? raw : 'http://$raw';
    return Uri.tryParse(withScheme);
  }

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    cursorBaseUrl = prefs.getString(_kCursorUrl) ?? cursorBaseUrl;
    cursorToken = prefs.getString(_kCursorToken) ?? cursorToken;
    claudeUrl = prefs.getString(_kClaudeUrl) ?? claudeUrl;
  }

  Future<void> save() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kCursorUrl, cursorBaseUrl.trim());
    await prefs.setString(_kCursorToken, cursorToken.trim());
    await prefs.setString(_kClaudeUrl, claudeUrl.trim());
  }

  Future<void> clearPairing() async {
    cursorToken = '';
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kCursorToken);
  }
}
