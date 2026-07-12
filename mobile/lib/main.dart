import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'agent_webview.dart';
import 'app_settings.dart';
import 'onboarding_screen.dart';
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
  String? _cursorLoadUrl;
  Map<String, String>? _cursorHeaders;
  int _cursorViewKey = 0;
  int _claudeViewKey = 0;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    await _settings.load();
    _applyCursorConfig();
    setState(() => _ready = true);
  }

  void _applyCursorConfig() {
    if (!_settings.isPaired) {
      setState(() {
        _cursorLoadUrl = null;
        _cursorHeaders = null;
      });
      return;
    }
    final uri = _settings.cursorUri;
    if (uri == null) {
      setState(() {
        _cursorLoadUrl = null;
        _cursorHeaders = null;
      });
      return;
    }
    final headers = <String, String>{
      'Authorization': 'Bearer ${_settings.cursorToken}',
    };
    if (uri.host.contains('ngrok')) {
      headers['ngrok-skip-browser-warning'] = 'true';
    }
    setState(() {
      _cursorLoadUrl = uri.origin;
      _cursorHeaders = headers;
      _cursorViewKey++;
    });
  }

  Future<void> _onSettingsSaved(AppSettings _) async {
    setState(() => _claudeViewKey++);
    _applyCursorConfig();
    if (_settings.isPaired && _index == 2) {
      setState(() => _index = 0);
    }
  }

  Future<void> _injectCursorToken(WebViewController c, String url) async {
    final token = _settings.cursorToken;
    if (token.isEmpty) return;

    final js =
        "localStorage.setItem('cursor-remote-token', ${_jsString(token)});";
    await c.runJavaScript(js);
  }

  void _openSettings() {
    setState(() => _index = 2);
  }

  @override
  Widget build(BuildContext context) {
    if (!_ready) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }

    final isPaired = _settings.isPaired;

    return Scaffold(
      body: SafeArea(
        child: IndexedStack(
          index: _index,
          children: [
            isPaired ? _buildCursorPane() : OnboardingScreen(onPair: _openSettings),
            AgentWebView(
              key: ValueKey('claude-$_claudeViewKey'),
              url: _settings.claudeUrl.trim().isEmpty
                  ? 'https://claude.ai/code'
                  : _settings.claudeUrl.trim(),
            ),
            SettingsScreen(
              settings: _settings,
              onSaved: _onSettingsSaved,
            ),
          ],
        ),
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.terminal_outlined),
            selectedIcon: Icon(Icons.terminal),
            label: 'Agent',
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

  Widget _buildCursorPane() {
    if (_cursorLoadUrl == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.link_off, size: 48, color: Color(0xFF8B949E)),
              const SizedBox(height: 12),
              const Text('Not paired yet.'),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: _openSettings,
                child: const Text('Pair now'),
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
