import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

class AgentWebView extends StatefulWidget {
  const AgentWebView({
    super.key,
    required this.url,
    this.headers,
    this.onPageFinished,
    this.onControllerReady,
  });

  final String url;
  final Map<String, String>? headers;
  final Future<void> Function(WebViewController controller, String url)? onPageFinished;
  final void Function(WebViewController controller)? onControllerReady;

  @override
  State<AgentWebView> createState() => AgentWebViewState();
}

class AgentWebViewState extends State<AgentWebView> {
  late final WebViewController _controller;
  var _loading = true;
  var _progress = 0;
  String? _error;

  WebViewController get controller => _controller;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF0D1117))
      ..setNavigationDelegate(
        NavigationDelegate(
          onProgress: (p) {
            if (mounted) setState(() => _progress = p);
          },
          onPageStarted: (_) {
            if (mounted) {
              setState(() {
                _loading = true;
                _error = null;
              });
            }
          },
          onPageFinished: (url) async {
            if (widget.onPageFinished != null) {
              await widget.onPageFinished!(_controller, url);
            }
            if (mounted) setState(() => _loading = false);
          },
          onWebResourceError: (err) {
            if (mounted) {
              setState(() {
                _loading = false;
                _error = err.description;
              });
            }
          },
        ),
      );

    final platform = _controller.platform;
    if (platform is AndroidWebViewController) {
      platform.setMediaPlaybackRequiresUserGesture(false);
    }

    widget.onControllerReady?.call(_controller);
    _load();
  }

  @override
  void didUpdateWidget(covariant AgentWebView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.url != widget.url) {
      _load();
    }
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    final uri = Uri.parse(widget.url);
    final headers = widget.headers;
    if (headers != null && headers.isNotEmpty) {
      await _controller.loadRequest(uri, headers: headers);
    } else {
      await _controller.loadRequest(uri);
    }
  }

  Future<void> reload() => _controller.reload();

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        if (_error != null)
          _ErrorPane(message: _error!, onRetry: _load)
        else
          WebViewWidget(controller: _controller),
        if (_loading)
          LinearProgressIndicator(
            value: _progress > 0 && _progress < 100 ? _progress / 100 : null,
            minHeight: 2,
            backgroundColor: Colors.transparent,
          ),
      ],
    );
  }
}

class _ErrorPane extends StatelessWidget {
  const _ErrorPane({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.wifi_off, size: 48, color: Color(0xFF8B949E)),
            const SizedBox(height: 12),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Color(0xFFC9D1D9)),
            ),
            const SizedBox(height: 16),
            FilledButton(onPressed: onRetry, child: const Text('Retry')),
          ],
        ),
      ),
    );
  }
}
