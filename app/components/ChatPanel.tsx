/**
 * ChatPanel — terminal-style collapsible session overlay.
 *
 * Collapsed: handle bar + InputBar
 * Expanded: handle bar + terminal-style scrollable output + InputBar
 *
 * Auto-expands when user sends a message.
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

export default function ChatPanel({
  messages, onSend, onStop, onSketch, onImage, onFile,
  connected, isProcessing,
}: ChatPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const toggle = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(prev => !prev);
  }, []);

  // Auto-expand when user sends a message (new messages arrive)
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

  const renderMessage = (msg: SessionMessage) => {
    const mono = styles.mono;
    switch (msg.content.type) {
      case 'text': {
        const isUser = msg.role === 'user';
        const text = msg.content.text;
        if (!text) return null;

        const display = !isUser && text.length > 800
          ? text.slice(0, 800) + '...'
          : text;

        // Terminal style: "> " prefix for user, no prefix for agent
        return (
          <View key={msg.id} style={styles.termLine}>
            <Text selectable style={[mono, isUser ? styles.termUser : styles.termAgent]}>
              {isUser ? `> ${display}` : display}
            </Text>
          </View>
        );
      }

      case 'tool_call_start':
        return (
          <View key={msg.id} style={styles.termLine}>
            <Text selectable style={[mono, styles.termTool]}>~ {msg.content.name}</Text>
          </View>
        );

      case 'service_message':
        return (
          <View key={msg.id} style={styles.termLine}>
            <Text selectable style={[mono, styles.termSystem]} numberOfLines={2}>
              {msg.content.text}
            </Text>
          </View>
        );

      default:
        return null;
    }
  };

  const msgCount = messages.filter(m =>
    m.content.type === 'text' || m.content.type === 'tool_call_start'
  ).length;

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
            <Text selectable style={styles.handleHint}>{msgCount} messages</Text>
          )}
        </TouchableOpacity>

        {/* Message list */}
        {expanded && (
          <ScrollView
            ref={scrollRef}
            style={styles.messageList}
            contentContainerStyle={styles.messageListContent}
            onContentSizeChange={scrollToBottom}
            keyboardShouldPersistTaps="handled"
          >
            {msgCount === 0 ? (
              <Text selectable style={styles.emptyText}>No messages yet</Text>
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

  // Terminal-style messages
  mono: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
    lineHeight: 18,
  },
  termLine: {
    marginBottom: 4,
  },
  termUser: {
    color: '#30d158',
  },
  termAgent: {
    color: '#aaa',
  },
  termTool: {
    color: '#555',
  },
  termSystem: {
    color: '#3a3a3a',
  },
});
