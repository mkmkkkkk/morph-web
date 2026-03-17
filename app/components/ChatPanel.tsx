/**
 * ChatPanel — full terminal mirror of Claude Code session.
 *
 * Collapsed: handle bar + InputBar
 * Expanded: 100% terminal view — every CC event rendered
 *
 * Auto-expands when messages arrive.
 * Collapses only when user taps the handle bar.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  LayoutAnimation, Platform, UIManager, Dimensions, KeyboardAvoidingView,
} from 'react-native';
import InputBar from './InputBar';
import { type SessionMessage } from '../lib/protocol';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface ChatPanelProps {
  messages: SessionMessage[];
  onSend: (text: string) => void;
  onStop?: () => void;
  onSketch?: () => void;
  onImage?: (base64DataUrl: string) => void;
  onFile?: (file: { name: string; mime: string; base64: string; size: number }) => void;
  connected: boolean;
  isProcessing?: boolean;
}

const SCREEN_HEIGHT = Dimensions.get('window').height;
const EXPANDED_HEIGHT = SCREEN_HEIGHT * 0.55;

console.log('[ChatPanel] module loaded');

export default function ChatPanel({
  messages, onSend, onStop, onSketch, onImage, onFile,
  connected, isProcessing,
}: ChatPanelProps) {
  console.log('[ChatPanel] render: messages=', messages.length, 'connected=', connected, 'isProcessing=', isProcessing);
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const toggle = useCallback(() => {
    console.log('[ChatPanel] HANDLE BAR TAPPED, toggling expanded');
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(prev => !prev);
  }, []);

  // Auto-expand when messages arrive
  const prevMsgCount = useRef(0);
  useEffect(() => {
    const currentCount = messages.length;
    if (currentCount > prevMsgCount.current && !expanded) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setExpanded(true);
    }
    prevMsgCount.current = currentCount;
  }, [messages.length]);

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, []);

  // ---------------------------------------------------------------
  // Render every message type — full terminal mirror, nothing skipped
  // ---------------------------------------------------------------
  const renderMessage = (msg: SessionMessage) => {
    try {
      const mono = styles.mono;
      switch (msg.content.type) {
        case 'text': {
          const isUser = msg.role === 'user';
          const text = msg.content.text;
          if (!text) return null;

          const isThinking = (msg.content as any).thinking;

          return (
            <View key={msg.id} style={styles.termLine}>
              <Text selectable style={[mono, isUser ? styles.termUser : isThinking ? styles.termThinking : styles.termAgent]}>
                {isUser ? `> ${text}` : text}
              </Text>
            </View>
          );
        }

        case 'tool_call_start': {
          const params = msg.content.params;
          const paramStr = params
            ? typeof params === 'string'
              ? params.slice(0, 150)
              : JSON.stringify(params).slice(0, 150)
            : '';
          return (
            <View key={msg.id} style={styles.termLine}>
              <Text selectable style={[mono, styles.termToolName]}>
                {'> '}{msg.content.name}
              </Text>
              {paramStr ? (
                <Text selectable style={[mono, styles.termToolParam]}>
                  {paramStr}
                </Text>
              ) : null}
            </View>
          );
        }

        case 'tool_call_end': {
          const result = msg.content.result;
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
          const display = resultStr.length > 500 ? resultStr.slice(0, 500) + '...' : resultStr;
          return (
            <View key={msg.id} style={styles.termLine}>
              <Text selectable style={[mono, styles.termToolResult]}>
                {display}
              </Text>
            </View>
          );
        }

        case 'turn_start':
          return (
            <View key={msg.id} style={styles.termDivider}>
              <View style={styles.dividerLine} />
            </View>
          );

        case 'turn_end':
          return (
            <View key={msg.id} style={styles.termDivider}>
              <Text selectable style={[mono, styles.termSystem]}>
                {msg.content.status === 'completed' ? '--- done ---' : `--- ${msg.content.status} ---`}
              </Text>
            </View>
          );

        case 'file':
          return (
            <View key={msg.id} style={styles.termLine}>
              <Text selectable style={[mono, styles.termToolName]}>
                file: {msg.content.name} ({(msg.content.size / 1024).toFixed(1)}KB)
              </Text>
            </View>
          );

        case 'service_message':
          return (
            <View key={msg.id} style={styles.termLine}>
              <Text selectable style={[mono, styles.termSystem]}>
                {msg.content.text}
              </Text>
            </View>
          );

        case 'session_start':
          return (
            <View key={msg.id} style={styles.termDivider}>
              <Text selectable style={[mono, styles.termSystem]}>session connected</Text>
            </View>
          );

        case 'session_stop':
          return (
            <View key={msg.id} style={styles.termDivider}>
              <Text selectable style={[mono, styles.termSystem]}>session ended</Text>
            </View>
          );

        default:
          // Catch-all: render raw JSON so nothing is hidden
          return (
            <View key={msg.id} style={styles.termLine}>
              <Text selectable style={[mono, styles.termSystem]}>
                [{(msg.content as any).type}] {JSON.stringify(msg.content).slice(0, 300)}
              </Text>
            </View>
          );
      }
    } catch (err: any) {
      console.error('[ChatPanel] renderMessage THREW:', err?.message, 'msg=', JSON.stringify(msg).slice(0, 200));
      return (
        <View key={msg.id || `err_${Date.now()}`} style={styles.termLine}>
          <Text selectable style={[styles.mono, styles.termError]}>render error: {err?.message}</Text>
        </View>
      );
    }
  };

  const msgCount = messages.length;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={[styles.container, expanded && { height: EXPANDED_HEIGHT }]}>
        {/* Handle bar */}
        <TouchableOpacity style={styles.handle} onPress={toggle} activeOpacity={0.6}>
          <View style={styles.handleBar} />
          {!expanded && msgCount > 0 && (
            <Text selectable style={styles.handleHint}>{msgCount}</Text>
          )}
        </TouchableOpacity>

        {/* Terminal output */}
        {expanded && (
          <ScrollView
            ref={scrollRef}
            style={styles.messageList}
            contentContainerStyle={styles.messageListContent}
            onContentSizeChange={scrollToBottom}
            keyboardShouldPersistTaps="handled"
          >
            {msgCount === 0 ? (
              <Text selectable style={styles.emptyText}>waiting for session...</Text>
            ) : (
              messages.map(renderMessage)
            )}
          </ScrollView>
        )}

        {/* InputBar */}
        <InputBar
          onSend={onSend}
          onStop={onStop}
          onSketch={onSketch}
          onImage={onImage}
          onFile={onFile}
          connected={connected}
          isProcessing={isProcessing}
          forceDark
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {},

  handle: {
    alignItems: 'center',
    paddingVertical: 6,
    backgroundColor: '#0a0a0a',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  handleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#333',
  },
  handleHint: {
    color: '#444',
    fontSize: 11,
    marginTop: 2,
  },

  messageList: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  messageListContent: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  emptyText: {
    color: '#333',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 16,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  // Terminal styles
  mono: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    lineHeight: 17,
  },
  termLine: {
    marginBottom: 3,
  },
  termDivider: {
    marginVertical: 4,
    alignItems: 'center',
  },
  dividerLine: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#222',
    width: '100%',
  },

  // User input — green
  termUser: {
    color: '#30d158',
  },
  // Agent text — light grey
  termAgent: {
    color: '#ccc',
  },
  // Thinking — dim purple
  termThinking: {
    color: '#8e8ea0',
    fontStyle: 'italic',
  },
  // Tool name — yellow
  termToolName: {
    color: '#b0903a',
  },
  // Tool params — dim
  termToolParam: {
    color: '#555',
    fontSize: 11,
  },
  // Tool result — dim grey
  termToolResult: {
    color: '#666',
    fontSize: 11,
    lineHeight: 15,
  },
  // System/service — very dim
  termSystem: {
    color: '#3a3a3a',
  },
  // Error — red
  termError: {
    color: '#ff4444',
  },
});
