import 'package:flutter/material.dart';

class OnboardingScreen extends StatelessWidget {
  const OnboardingScreen({super.key, required this.onPair});

  final VoidCallback onPair;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(
                color: const Color(0xFF58A6FF).withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(18),
              ),
              child: const Icon(
                Icons.bolt,
                size: 40,
                color: Color(0xFF58A6FF),
              ),
            ),
            const SizedBox(height: 20),
            const Text(
              'CursorRemote',
              style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 8),
            const Text(
              'Control your Cursor AI agent from your phone.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Color(0xFF8B949E), fontSize: 14, height: 1.45),
            ),
            const SizedBox(height: 28),
            _step(1, 'Open CursorRemote: Setup in Cursor\'s command palette.'),
            _step(2, 'Copy the pairing code shown in the setup panel.'),
            _step(3, 'Paste it in the Setup tab here to pair.'),
            const SizedBox(height: 28),
            FilledButton(
              onPressed: onPair,
              child: const Text('Go to Setup'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _step(int n, String text) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 26,
            height: 26,
            decoration: BoxDecoration(
              color: const Color(0xFF58A6FF).withValues(alpha: 0.15),
              border: Border.all(color: const Color(0xFF58A6FF)),
              borderRadius: BorderRadius.circular(13),
            ),
            alignment: Alignment.center,
            child: Text(
              '$n',
              style: const TextStyle(
                color: Color(0xFF58A6FF),
                fontWeight: FontWeight.w700,
                fontSize: 13,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text(
                text,
                style: const TextStyle(fontSize: 14, height: 1.4),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
