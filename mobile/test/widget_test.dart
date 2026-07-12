import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:cursor_remote_mobile/main.dart';

void main() {
  testWidgets('App boots', (tester) async {
    await tester.pumpWidget(const CursorRemoteApp());
    await tester.pump();
    expect(find.byType(CursorRemoteApp), findsOneWidget);
  });
}
