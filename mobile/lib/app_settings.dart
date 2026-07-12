import 'package:shared_preferences/shared_preferences.dart';

class AppSettings {
  AppSettings({
    this.cursorBaseUrl = '',
    this.cursorPassword = '',
    this.claudeUrl = 'https://claude.ai/code',
  });

  String cursorBaseUrl;
  String cursorPassword;
  String claudeUrl;

  static const _kCursorUrl = 'cursor_base_url';
  static const _kCursorPw = 'cursor_password';
  static const _kClaudeUrl = 'claude_url';

  bool get hasCursorConfig => cursorBaseUrl.trim().isNotEmpty;

  Uri? get cursorUri {
    final raw = cursorBaseUrl.trim();
    if (raw.isEmpty) return null;
    final withScheme = raw.contains('://') ? raw : 'http://$raw';
    return Uri.tryParse(withScheme);
  }

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    cursorBaseUrl = prefs.getString(_kCursorUrl) ?? cursorBaseUrl;
    cursorPassword = prefs.getString(_kCursorPw) ?? cursorPassword;
    claudeUrl = prefs.getString(_kClaudeUrl) ?? claudeUrl;
  }

  Future<void> save() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kCursorUrl, cursorBaseUrl.trim());
    await prefs.setString(_kCursorPw, cursorPassword);
    await prefs.setString(_kClaudeUrl, claudeUrl.trim());
  }
}
