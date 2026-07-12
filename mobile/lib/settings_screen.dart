import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app_settings.dart';
import 'cursor_auth.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({
    super.key,
    required this.settings,
    required this.onSaved,
  });

  final AppSettings settings;
  final Future<void> Function(AppSettings) onSaved;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late final TextEditingController _serverUrl;
  late final TextEditingController _pairCode;
  late final TextEditingController _claudeUrl;
  var _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _serverUrl = TextEditingController(text: widget.settings.cursorBaseUrl);
    _pairCode = TextEditingController();
    _claudeUrl = TextEditingController(text: widget.settings.claudeUrl);
  }

  @override
  void dispose() {
    _serverUrl.dispose();
    _pairCode.dispose();
    _claudeUrl.dispose();
    super.dispose();
  }

  Future<void> _pair() async {
    final rawUrl = _serverUrl.text.trim();
    final code = _pairCode.text.trim();
    if (rawUrl.isEmpty) {
      setState(() => _error = 'Enter the server address first.');
      return;
    }
    if (code.isEmpty) {
      setState(() => _error = 'Enter the pairing code from Cursor.');
      return;
    }

    setState(() {
      _saving = true;
      _error = null;
    });

    final withScheme = rawUrl.contains('://') ? rawUrl : 'http://$rawUrl';
    final uri = Uri.tryParse(withScheme);
    if (uri == null || uri.host.isEmpty) {
      setState(() {
        _saving = false;
        _error = 'Invalid server address.';
      });
      return;
    }

    final auth = await pairWithCursorRemote(baseUri: uri, code: code);
    if (!mounted) return;

    if (!auth.ok || auth.token == null) {
      setState(() {
        _saving = false;
        _error = auth.error ?? 'Pairing failed.';
      });
      return;
    }

    widget.settings.cursorBaseUrl = rawUrl;
    widget.settings.cursorToken = auth.token!;
    widget.settings.claudeUrl = _claudeUrl.text.isEmpty
        ? 'https://claude.ai/code'
        : _claudeUrl.text;
    await widget.settings.save();
    await widget.onSaved(widget.settings);

    if (mounted) {
      setState(() => _saving = false);
      _pairCode.clear();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Paired successfully')),
      );
    }
  }

  Future<void> _unpair() async {
    await widget.settings.clearPairing();
    await widget.onSaved(widget.settings);
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Unpaired. Enter a new code to reconnect.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final isPaired = widget.settings.isPaired;
    const labelStyle = TextStyle(
      color: Color(0xFF8B949E),
      fontSize: 13,
      fontWeight: FontWeight.w600,
    );

    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 32),
      children: [
        // Status badge
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: isPaired
                ? const Color(0xFF1F3D2A)
                : const Color(0xFF2A1F1F),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
              color: isPaired
                  ? const Color(0xFF3FB950)
                  : const Color(0xFFF85149),
              width: 1,
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                isPaired ? Icons.check_circle : Icons.lock_outline,
                size: 14,
                color: isPaired
                    ? const Color(0xFF3FB950)
                    : const Color(0xFFF85149),
              ),
              const SizedBox(width: 6),
              Text(
                isPaired ? 'Paired' : 'Not paired',
                style: TextStyle(
                  color: isPaired
                      ? const Color(0xFF3FB950)
                      : const Color(0xFFF85149),
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 24),

        // Pairing section
        const Text('Pair with Cursor', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        const Text(
          'Open CursorRemote: Setup in Cursor\'s command palette and copy the pairing code.',
          style: TextStyle(color: Color(0xFF8B949E), fontSize: 13, height: 1.4),
        ),
        const SizedBox(height: 16),

        const Text('Server address', style: labelStyle),
        const SizedBox(height: 6),
        TextField(
          controller: _serverUrl,
          keyboardType: TextInputType.url,
          autocorrect: false,
          enabled: !isPaired,
          decoration: const InputDecoration(
            hintText: '100.64.0.1:3000',
            prefixIcon: Icon(Icons.link),
          ),
        ),
        const SizedBox(height: 14),

        const Text('Pairing code', style: labelStyle),
        const SizedBox(height: 6),
        TextField(
          controller: _pairCode,
          keyboardType: TextInputType.visiblePassword,
          autocorrect: false,
          enabled: !isPaired,
          textCapitalization: TextCapitalization.characters,
          decoration: const InputDecoration(
            hintText: 'XXX-XXX',
            prefixIcon: Icon(Icons.key),
          ),
        ),
        const SizedBox(height: 18),

        if (!isPaired)
          FilledButton(
            onPressed: _saving ? null : _pair,
            child: _saving
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Pair'),
          )
        else
          OutlinedButton(
            onPressed: _unpair,
            child: const Text('Unpair'),
          ),

        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(
            _error!,
            style: const TextStyle(color: Color(0xFFF85149), fontSize: 13),
          ),
        ],

        const SizedBox(height: 32),

        // Claude section
        const Text('Claude Code', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        const Text(
          'On your Mac run: claude remote-control\n'
          'Then open the session here. Login with the same Anthropic account.',
          style: TextStyle(color: Color(0xFF8B949E), fontSize: 13, height: 1.4),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                onPressed: () async {
                  await Clipboard.setData(
                    const ClipboardData(text: 'claude remote-control'),
                  );
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Command copied')),
                    );
                  }
                },
                icon: const Icon(Icons.copy, size: 16),
                label: const Text('Copy CLI command'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 14),
        const Text('Claude URL', style: labelStyle),
        const SizedBox(height: 6),
        TextField(
          controller: _claudeUrl,
          keyboardType: TextInputType.url,
          autocorrect: false,
          decoration: const InputDecoration(
            hintText: 'https://claude.ai/code',
            prefixIcon: Icon(Icons.smart_toy_outlined),
          ),
        ),
        const SizedBox(height: 20),
        FilledButton.tonal(
          onPressed: _saving
              ? null
              : () async {
                  widget.settings.claudeUrl = _claudeUrl.text.isEmpty
                      ? 'https://claude.ai/code'
                      : _claudeUrl.text;
                  await widget.settings.save();
                  await widget.onSaved(widget.settings);
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Claude URL saved')),
                    );
                  }
                },
          child: const Text('Save Claude URL'),
        ),
      ],
    );
  }
}
