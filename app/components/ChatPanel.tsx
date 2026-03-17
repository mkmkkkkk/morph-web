/**
 * ChatPanel — InputBar at bottom + toggle terminal overlay.
 *
 * Tap the terminal button (left of input) → terminal pops up.
 * Tap again → hides. Simple toggle, no sliding.
 *
 * Thinking & tool results collapsed by default (tap to expand).
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Platform, UIManager, Dimensions, KeyboardAvoidingView,
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
const TERMINAL_HEIGHT = SCREEN_HEIGHT * 0.5;

// ---------------------------------------------------------------
// CollapsibleBlock — tap header to expand/collapse content
// ---------------------------------------------------------------
function CollapsibleBlock({ label, preview, headerStyle, content, contentStyle, defaultOpen = false }: {
  label: string;
  preview?: string;
  headerStyle: any;
  content: string;
  contentStyle: any;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View style={styles.termLine}>
      <TouchableOpacity onPress={() => setOpen(prev => !prev)} activeOpacity={0.5}>
        <Text selectable style={headerStyle}>
          {open ? '▾ ' : '▸ '}{label}{!open && preview ? `: ${preview}` : ''}
        </Text>
      </TouchableOpacity>
      {open && content ? (
        <Text selectable style={contentStyle}>
          {content}
        </Text>
      ) : null}
    </View>
  );
}

export default function ChatPanel({
  messages, onSend, onStop, onSketch, onImage, onFile,
  connected, isProcessing,
}: ChatPanelProps) {
  const [terminalVisible, setTerminalVisible] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const prevMsgCount = useRef(0);

  // Auto-scroll when new messages arrive
  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, []);

  // Flash the terminal button when new messages arrive while hidden
  const [hasNew, setHasNew] = useState(false);
  useEffect(() => {
    if (messages.length > prevMsgCount.current) {
      if (!terminalVisible) setHasNew(true);
    }
    prevMsgCount.current = messages.length;
  }, [messages.length, terminalVisible]);

  const toggleTerminal = useCallback(() => {
    setTerminalVisible(prev => !prev);
    setHasNew(false);
  }, []);

  // ---------------------------------------------------------------
  // Visibility filter — hide noise, show what matters
  // ---------------------------------------------------------------
  const HIDDEN_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Task', 'TodoWrite', 'Agent']);

  const renderMessage = (msg: SessionMessage) => {
    try {
      const mono = styles.mono;

      // Hide: service_message, session_start
      if (msg.content.type === 'service_message' || msg.content.type === 'session_start') {
        return null;
      }
      if (msg.content.type === 'tool_call_start' && HIDDEN_TOOLS.has(msg.content.name)) {
        return null;
      }
      if (msg.content.type === 'tool_call_end' && (!msg.content.name || HIDDEN_TOOLS.has(msg.content.name))) {
        return null;
      }

      switch (msg.content.type) {
        case 'text': {
          const isUser = msg.role === 'user';
          const text = msg.content.text;
          if (!text) return null;

          const isThinking = (msg.content as any).thinking;

          if (isThinking) {
            const prev = text.length > 60 ? text.slice(0, 60) + '...' : text;
            return (
              <CollapsibleBlock
                key={msg.id}
                label="thinking"
                preview={prev}
                headerStyle={[mono, styles.termThinking]}
                content={text}
                contentStyle={[mono, styles.termThinkingBody]}
              />
            );
          }

          return (
            <View key={msg.id} style={styles.termLine}>
              <Text selectable style={[mono, isUser ? styles.termUser : styles.termAgent]}>
                {isUser ? `> ${text}` : text}
              </Text>
            </View>
          );
        }

        case 'tool_call_start': {
          const params = msg.content.params;
          const paramStr = params
            ? typeof params === 'string'
              ? params
              : JSON.stringify(params)
            : '';
          if (paramStr && paramStr.length > 80) {
            const prev = paramStr.length > 60 ? paramStr.slice(0, 60).replace(/\n/g, ' ') + '...' : paramStr.replace(/\n/g, ' ');
            return (
              <CollapsibleBlock
                key={msg.id}
                label={msg.content.name}
                preview={prev}
                headerStyle={[mono, styles.termToolName]}
                content={paramStr}
                contentStyle={[mono, styles.termToolParam]}
              />
            );
          }
          return (
            <View key={msg.id} style={styles.termLine}>
              <Text selectable style={[mono, styles.termToolName]}>
                {'> '}{msg.content.name}
              </Text>
              {paramStr ? (
                <Text selectable style={[mono, styles.termToolParam]} numberOfLines={2}>
                  {paramStr}
                </Text>
              ) : null}
            </View>
          );
        }

        case 'tool_call_end': {
          const result = msg.content.result;
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
          const prev = resultStr.length > 60 ? resultStr.slice(0, 60).replace(/\n/g, ' ') + '...' : resultStr.replace(/\n/g, ' ');
          return (
            <CollapsibleBlock
              key={msg.id}
              label="result"
              preview={prev}
              headerStyle={[mono, styles.termToolResultHeader]}
              content={resultStr.length > 2000 ? resultStr.slice(0, 2000) + '\n...' : resultStr}
              contentStyle={[mono, styles.termToolResult]}
            />
          );
        }

        case 'turn_end':
          return (
            <View key={msg.id} style={styles.termDivider}>
              <Text selectable style={[mono, styles.termSystem]}>
                {msg.content.status === 'completed' ? '--- done ---' : `--- ${msg.content.status} ---`}
              </Text>
            </View>
          );

        default:
          return null;
      }
    } catch (err: any) {
      return (
        <View key={msg.id || `err_${Date.now()}`} style={styles.termLine}>
          <Text selectable style={[styles.mono, styles.termError]}>render error: {err?.message}</Text>
        </View>
      );
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={styles.container}>
        {/* Terminal overlay — appears above InputBar */}
        {terminalVisible && (
          <View style={styles.terminal}>
            <ScrollView
              ref={scrollRef}
              style={styles.terminalScroll}
              contentContainerStyle={styles.terminalContent}
              onContentSizeChange={scrollToBottom}
              keyboardShouldPersistTaps="handled"
            >
              {messages.length === 0 ? (
                <Text selectable style={styles.emptyText}>waiting for session...</Text>
              ) : (
                messages.map(renderMessage)
              )}
            </ScrollView>
          </View>
        )}

        {/* Input row: terminal toggle + InputBar */}
        <View style={styles.inputRow}>
          <TouchableOpacity
            style={[styles.termToggle, terminalVisible && styles.termToggleActive]}
            onPress={toggleTerminal}
            activeOpacity={0.6}
          >
            <Text style={[styles.termToggleIcon, hasNew && styles.termToggleNew]}>
              {terminalVisible ? '▾' : '▸'}
            </Text>
          </TouchableOpacity>
          <View style={styles.inputBarWrap}>
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
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {},

  // Terminal overlay
  terminal: {
    height: TERMINAL_HEIGHT,
    backgroundColor: '#0a0a0a',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  terminalScroll: {
    flex: 1,
  },
  terminalContent: {
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

  // Input row
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: '#0a0a0a',
  },
  termToggle: {
    width: 32,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 4,
  },
  termToggleActive: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 6,
  },
  termToggleIcon: {
    color: '#555',
    fontSize: 16,
    fontWeight: '600',
  },
  termToggleNew: {
    color: '#30d158',
  },
  inputBarWrap: {
    flex: 1,
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

  // User input — green
  termUser: {
    color: '#30d158',
  },
  // Agent text — light grey
  termAgent: {
    color: '#ccc',
  },
  // Thinking header — dim purple
  termThinking: {
    color: '#8e8ea0',
    fontStyle: 'italic',
  },
  termThinkingBody: {
    color: '#6e6e80',
    fontStyle: 'italic',
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
    paddingLeft: 12,
  },
  // Tool name — yellow
  termToolName: {
    color: '#b0903a',
  },
  termToolParam: {
    color: '#555',
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
    paddingLeft: 12,
  },
  termToolResultHeader: {
    color: '#555',
    fontSize: 11,
  },
  termToolResult: {
    color: '#666',
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
    paddingLeft: 12,
  },
  // System — very dim
  termSystem: {
    color: '#3a3a3a',
  },
  termError: {
    color: '#ff4444',
  },
});
