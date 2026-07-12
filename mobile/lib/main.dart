import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'agent_webview.dart';
import 'app_settings.dart';
import 'cursor_auth.dart';
import 'settings_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const CursorRemoteApp());
}

class CursorRemoteApp extends StatelessWidget {
  const CursorRemoteApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'CursorRemote',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        colorScheme: const ColorScheme.dark(
          primary: Color(0xFF58A6FF),
          surface: Color(0xFF0D1117),
          onSurface: Color(0xFFE6EDF3),
        ),
        scaffoldBackgroundColor: const Color(0xFF0D1117),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: const Color(0xFF161B22),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: Color(0xFF30363D)),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: Color(0xFF30363D)),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: Color(0xFF58A6FF)),
          ),
        ),
      ),
      home: const HomeShell(),
    );
  }
}

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  final _settings = AppSettings();
  var _index = 0;
  var _ready = false;
  var _cursorConnecting = false;
  String? _cursorToken;
  String? _cursorError;
  String? _cursorLoadUrl;
  Map<String, String>? _cursorHeaders;
  WebViewController? _claudeController;
  final _tokenInjected = <String>{};
  int _cursorViewKey = 0;
  int _claudeViewKey = 0;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    await _settings.load();
    setState(() => _ready = true);
    if (_settings.hasCursorConfig) {
      await _connectCursor();
    } else {
      setState(() => _index = 2);
    }
  }

  Future<void> _connectCursor() async {
    final uri = _settings.cursorUri;
    if (uri == null) {
      setState(() => _cursorError = 'Invalid CursorRemote URL');
      return;
    }

    setState(() {
      _cursorConnecting = true;
      _cursorError = null;
      _tokenInjected.clear();
    });

    final auth = await loginCursorRemote(
      baseUri: uri,
      password: _settings.cursorPassword,
    );

    if (!mounted) return;

    if (!auth.ok || auth.token == null) {
      setState(() {
        _cursorConnecting = false;
        _cursorError = auth.error ?? 'Login failed';
        _cursorToken = null;
        _cursorLoadUrl = null;
        _cursorHeaders = null;
      });
      return;
    }

    final headers = <String, String>{};
    if (auth.token != 'no-auth') {
      headers['Authorization'] = 'Bearer ${auth.token}';
    }

    setState(() {
      _cursorConnecting = false;
      _cursorToken = auth.token;
      _cursorLoadUrl = uri.origin;
      _cursorHeaders = headers.isEmpty ? null : headers;
      _cursorViewKey++;
    });
  }

  Future<void> _onSettingsSaved(AppSettings _) async {
    setState(() {
      _claudeViewKey++;
      _index = 0;
    });
    await _connectCursor();
  }

  Future<void> _injectCursorToken(WebViewController c, String url) async {
    final token = _cursorToken;
    if (token == null || token == 'no-auth') return;
    if (_tokenInjected.contains(url)) return;

    final js =
        "localStorage.setItem('cursor-remote-token', ${_jsString(token)});";
    await c.runJavaScript(js);
    _tokenInjected.add(url);

    // Reload once so socket.io picks up the token from localStorage.
    if (!_tokenInjected.contains('$url#reloaded')) {
      _tokenInjected.add('$url#reloaded');
      await c.reload();
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_ready) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(_titleFor(_index)),
        actions: [
          if (_index == 0)
            IconButton(
              tooltip: 'Reload Cursor',
              onPressed: _cursorConnecting ? null : _connectCursor,
              icon: const Icon(Icons.refresh),
            ),
          if (_index == 1)
            IconButton(
              tooltip: 'Reload Claude',
              onPressed: () => _claudeController?.reload(),
              icon: const Icon(Icons.refresh),
            ),
        ],
      ),
      body: IndexedStack(
        index: _index,
        children: [
          _buildCursorPane(),
          AgentWebView(
            key: ValueKey('claude-$_claudeViewKey'),
            url: _settings.claudeUrl.trim().isEmpty
                ? 'https://claude.ai/code'
                : _settings.claudeUrl.trim(),
            onControllerReady: (c) => _claudeController = c,
          ),
          SettingsScreen(
            settings: _settings,
            onSaved: _onSettingsSaved,
          ),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.terminal_outlined),
            selectedIcon: Icon(Icons.terminal),
            label: 'Cursor',
          ),
          NavigationDestination(
            icon: Icon(Icons.smart_toy_outlined),
            selectedIcon: Icon(Icons.smart_toy),
            label: 'Claude',
          ),
          NavigationDestination(
            icon: Icon(Icons.settings_outlined),
            selectedIcon: Icon(Icons.settings),
            label: 'Setup',
          ),
        ],
      ),
    );
  }

  String _titleFor(int i) => switch (i) {
        0 => 'Cursor',
        1 => 'Claude',
        _ => 'Setup',
      };

  Widget _buildCursorPane() {
    if (_cursorConnecting) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_cursorError != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, size: 48, color: Color(0xFFF85149)),
              const SizedBox(height: 12),
              Text(_cursorError!, textAlign: TextAlign.center),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: () => setState(() => _index = 2),
                child: const Text('Open Setup'),
              ),
              const SizedBox(height: 8),
              TextButton(
                onPressed: _connectCursor,
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }
    if (_cursorLoadUrl == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('Configure CursorRemote server in Setup.'),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: () => setState(() => _index = 2),
                child: const Text('Open Setup'),
              ),
            ],
          ),
        ),
      );
    }

    return AgentWebView(
      key: ValueKey('cursor-$_cursorViewKey'),
      url: _cursorLoadUrl!,
      headers: _cursorHeaders,
      onPageFinished: _injectCursorToken,
    );
  }
}

String _jsString(String value) {
  final escaped = value
      .replaceAll(r'\', r'\\')
      .replaceAll("'", r"\'")
      .replaceAll('\n', r'\n')
      .replaceAll('\r', r'\r');
  return "'$escaped'";
}
