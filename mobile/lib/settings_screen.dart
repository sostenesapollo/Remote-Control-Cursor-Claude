import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app_settings.dart';

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
  late final TextEditingController _cursorUrl;
  late final TextEditingController _cursorPw;
  late final TextEditingController _claudeUrl;
  var _saving = false;
  var _obscure = true;

  @override
  void initState() {
    super.initState();
    _cursorUrl = TextEditingController(text: widget.settings.cursorBaseUrl);
    _cursorPw = TextEditingController(text: widget.settings.cursorPassword);
    _claudeUrl = TextEditingController(text: widget.settings.claudeUrl);
  }

  @override
  void dispose() {
    _cursorUrl.dispose();
    _cursorPw.dispose();
    _claudeUrl.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    widget.settings.cursorBaseUrl = _cursorUrl.text;
    widget.settings.cursorPassword = _cursorPw.text;
    widget.settings.claudeUrl = _claudeUrl.text.isEmpty
        ? 'https://claude.ai/code'
        : _claudeUrl.text;
    await widget.settings.save();
    await widget.onSaved(widget.settings);
    if (mounted) {
      setState(() => _saving = false);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Saved')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    const labelStyle = TextStyle(
      color: Color(0xFF8B949E),
      fontSize: 13,
      fontWeight: FontWeight.w600,
    );

    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
      children: [
        const Text('CursorRemote', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        const Text(
          'IP:port from Setup Panel (LAN or Tailscale). Example: 100.x.x.x:3000',
          style: TextStyle(color: Color(0xFF8B949E), fontSize: 13, height: 1.35),
        ),
        const SizedBox(height: 16),
        const Text('Server URL', style: labelStyle),
        const SizedBox(height: 6),
        TextField(
          controller: _cursorUrl,
          keyboardType: TextInputType.url,
          autocorrect: false,
          decoration: const InputDecoration(
            hintText: '100.64.0.1:3000',
            prefixIcon: Icon(Icons.link),
          ),
        ),
        const SizedBox(height: 14),
        const Text('Password', style: labelStyle),
        const SizedBox(height: 6),
        TextField(
          controller: _cursorPw,
          obscureText: _obscure,
          autocorrect: false,
          decoration: InputDecoration(
            hintText: 'Web client password',
            prefixIcon: const Icon(Icons.lock_outline),
            suffixIcon: IconButton(
              onPressed: () => setState(() => _obscure = !_obscure),
              icon: Icon(_obscure ? Icons.visibility : Icons.visibility_off),
            ),
          ),
        ),
        const SizedBox(height: 28),
        const Text('Claude Code', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        const Text(
          'On your Mac run: claude remote-control\n'
          'Then open the session here (or paste the session URL). '
          'Login with the same Anthropic account.',
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
        const SizedBox(height: 24),
        FilledButton(
          onPressed: _saving ? null : _save,
          child: _saving
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('Save & connect'),
        ),
      ],
    );
  }
}
