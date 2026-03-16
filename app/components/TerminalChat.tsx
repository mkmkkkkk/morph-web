/**
 * TerminalChat — terminal-style chat message renderer.
 *
 * Renders SessionMessages as a scrollable dark-theme conversation log,
 * replicating HappyCoder's terminal aesthetic.
 *
 * Supports prompt jumping: up/down arrow keys scroll to prev/next user message.
 */

import React, { useRef, useEffect, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Platform,
} from 'react-native';
import type { SessionMessage } from '../lib/protocol';

export interface TerminalChatHandle {
  jumpToPrevPrompt: () => void;
  jumpToNextPrompt: () => void;
}

interface TerminalChatProps {
  messages: SessionMessage[];
}

// 24px grid background — matches original canvas.html aesthetic
const GRID_SIZE = 24;
const GRID_COLOR = 'rgba(255,255,255,0.03)';

const webGridStyle = Platform.OS === 'web' ? {
  backgroundImage:
    'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), ' +
    'linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
  backgroundSize: '24px 24px',
} as any : {};

function GridOverlay({ height }: { height: number }) {
  if (Platform.OS === 'web') return null; // web uses CSS
  const cols = Math.ceil(400 / GRID_SIZE);
  const rows = Math.ceil(height / GRID_SIZE);
  return (
    <View style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}>
      {Array.from({ length: cols }, (_, i) => (
        <View key={`c${i}`} style={{ position: 'absolute', left: i * GRID_SIZE, top: 0, bottom: 0, width: 1, backgroundColor: GRID_COLOR }} />
      ))}
      {Array.from({ length: rows }, (_, i) => (
        <View key={`r${i}`} style={{ position: 'absolute', top: i * GRID_SIZE, left: 0, right: 0, height: 1, backgroundColor: GRID_COLOR }} />
      ))}
    </View>
  );
}

const TerminalChat = forwardRef<TerminalChatHandle, TerminalChatProps>(
  ({ messages }, ref) => {
    const scrollRef = useRef<ScrollView>(null);
    // Y offset for each user message (index in promptIndices → y position)
    const promptOffsetsRef = useRef<Map<string, number>>(new Map());
    const currentPromptRef = useRef(-1); // -1 = at bottom (latest)

    // Collect indices of user messages
    const promptIndices = messages
      .map((msg, i) => (msg.role === 'user' && msg.content.type === 'text' ? i : -1))
      .filter((i) => i !== -1);

    // Auto-scroll to bottom on new messages (reset prompt cursor)
    useEffect(() => {
      currentPromptRef.current = -1;
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    }, [messages.length]);

    // Track layout positions for user messages
    const handlePromptLayout = useCallback((msgId: string, y: number) => {
      promptOffsetsRef.current.set(msgId, y);
    }, []);

    // Jump to prev/next user prompt
    useImperativeHandle(ref, () => ({
      jumpToPrevPrompt: () => {
        if (promptIndices.length === 0) return;

        let target: number;
        if (currentPromptRef.current === -1) {
          // At bottom — jump to last prompt
          target = promptIndices.length - 1;
        } else if (currentPromptRef.current > 0) {
          target = currentPromptRef.current - 1;
        } else {
          return; // Already at first prompt
        }

        currentPromptRef.current = target;
        const msgId = messages[promptIndices[target]].id;
        const y = promptOffsetsRef.current.get(msgId);
        if (y !== undefined) {
          scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
        }
      },

      jumpToNextPrompt: () => {
        if (promptIndices.length === 0 || currentPromptRef.current === -1) return;

        if (currentPromptRef.current < promptIndices.length - 1) {
          const target = currentPromptRef.current + 1;
          currentPromptRef.current = target;
          const msgId = messages[promptIndices[target]].id;
          const y = promptOffsetsRef.current.get(msgId);
          if (y !== undefined) {
            scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
          }
        } else {
          // Past last prompt — scroll to bottom
          currentPromptRef.current = -1;
          scrollRef.current?.scrollToEnd({ animated: true });
        }
      },
    }), [messages, promptIndices]);

    if (messages.length === 0) {
      return (
        <View style={[styles.emptyContainer, webGridStyle]}>
          <GridOverlay height={800} />
          <Text style={styles.emptyLogo}>M</Text>
          <Text style={styles.emptyTitle}>Your canvas is empty</Text>
          <Text style={styles.emptySubtitle}>
            Connect to Claude Code, then ask it to{'\n'}build UI components for you.
          </Text>
          <View style={styles.hintList}>
            <View style={styles.hintItem}>
              <Text style={styles.hintNumber}>1</Text>
              <Text style={styles.hintText}>Pair via Settings tab</Text>
            </View>
            <View style={styles.hintItem}>
              <Text style={styles.hintNumber}>2</Text>
              <Text style={styles.hintText}>Type a request below</Text>
            </View>
            <View style={styles.hintItem}>
              <Text style={styles.hintNumber}>3</Text>
              <Text style={styles.hintText}>Long-press to adopt or remove</Text>
            </View>
          </View>
        </View>
      );
    }

    return (
      <View style={[styles.container, webGridStyle]}>
        <GridOverlay height={2000} />
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1, backgroundColor: 'transparent' }}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {messages.map((msg) => (
            <MessageBlock
              key={msg.id}
              message={msg}
              onPromptLayout={handlePromptLayout}
            />
          ))}
        </ScrollView>
      </View>
    );
  }
);

TerminalChat.displayName = 'TerminalChat';
export default TerminalChat;

// ---------------------------------------------------------------------------
// Message block renderer
// ---------------------------------------------------------------------------

function MessageBlock({ message, onPromptLayout }: {
  message: SessionMessage;
  onPromptLayout: (msgId: string, y: number) => void;
}) {
  const { role, content } = message;

  switch (content.type) {
    case 'text':
      return (
        <TextMessage
          role={role}
          text={content.text}
          thinking={content.thinking}
          msgId={message.id}
          onPromptLayout={role === 'user' ? onPromptLayout : undefined}
        />
      );
    case 'tool_call_start':
      return <ToolCallStart name={content.name} />;
    case 'tool_call_end':
      return <ToolCallEnd name={content.name} result={content.result} />;
    case 'turn_start':
      return <TurnSeparator />;
    case 'turn_end':
      return <TurnEnd status={content.status} />;
    case 'service_message':
      return <ServiceMessage text={content.text} />;
    case 'session_start':
      return <ServiceMessage text="Session started" />;
    case 'session_stop':
      return <ServiceMessage text="Session ended" />;
    case 'file':
      return <ServiceMessage text={`File: ${content.name} (${content.size}B)`} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Text message — user or agent
// ---------------------------------------------------------------------------

function TextMessage({ role, text, thinking, msgId, onPromptLayout }: {
  role: string;
  text: string;
  thinking?: boolean;
  msgId: string;
  onPromptLayout?: (msgId: string, y: number) => void;
}) {
  const isUser = role === 'user';

  if (isUser) {
    return (
      <View
        style={styles.userRow}
        onLayout={onPromptLayout
          ? (e) => onPromptLayout(msgId, e.nativeEvent.layout.y)
          : undefined}
      >
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{text}</Text>
        </View>
      </View>
    );
  }

  // Agent message
  return (
    <View style={styles.agentRow}>
      {thinking && <Text style={styles.thinkingLabel}>thinking</Text>}
      <Text style={[styles.agentText, thinking && styles.thinkingText]}>
        {text}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

function ToolCallStart({ name }: { name: string }) {
  return (
    <View style={styles.toolRow}>
      <Text style={styles.toolIcon}>{'>'}</Text>
      <Text style={styles.toolName}>{name}</Text>
      <Text style={styles.toolSpinner}>...</Text>
    </View>
  );
}

function ToolCallEnd({ name, result }: { name: string; result: any }) {
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
  const truncated = resultStr && resultStr.length > 200
    ? resultStr.slice(0, 200) + '...'
    : resultStr;

  return (
    <View style={styles.toolRow}>
      <Text style={styles.toolDone}>{'✓'}</Text>
      <Text style={styles.toolName}>{name}</Text>
      {truncated ? (
        <Text style={styles.toolResult} numberOfLines={3}>{truncated}</Text>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Turn markers
// ---------------------------------------------------------------------------

function TurnSeparator() {
  return <View style={styles.turnLine} />;
}

function TurnEnd({ status }: { status: string }) {
  return (
    <View style={styles.turnEndRow}>
      <View style={styles.turnLine} />
      <Text style={styles.turnEndText}>
        {status === 'completed' ? 'done' : status}
      </Text>
      <View style={styles.turnLine} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Service messages
// ---------------------------------------------------------------------------

function ServiceMessage({ text }: { text: string }) {
  return (
    <View style={styles.serviceRow}>
      <Text style={styles.serviceText}>{text}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  content: {
    padding: 16,
    paddingBottom: 8,
  },
  emptyContainer: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  emptyLogo: {
    fontSize: 48,
    color: '#fff',
    opacity: 0.12,
    fontWeight: '200',
    letterSpacing: -2,
    marginBottom: 20,
  },
  emptyTitle: {
    fontSize: 22,
    color: '#666',
    fontWeight: '500',
    letterSpacing: -0.5,
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#444',
    lineHeight: 21,
    textAlign: 'center',
    maxWidth: 260,
  },
  hintList: {
    marginTop: 32,
    gap: 8,
  },
  hintItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.02)',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    gap: 8,
  },
  hintNumber: {
    color: '#555',
    fontSize: 14,
  },
  hintText: {
    color: '#555',
    fontSize: 13,
  },

  // User messages — right-aligned bubble
  userRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 12,
  },
  userBubble: {
    backgroundColor: '#1e3a2f',
    borderRadius: 16,
    borderBottomRightRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: '80%',
  },
  userText: {
    color: '#d4f5d4',
    fontSize: 15,
    lineHeight: 21,
  },

  // Agent messages — left-aligned, no bubble
  agentRow: {
    marginBottom: 12,
  },
  agentText: {
    color: '#e0e0e0',
    fontSize: 15,
    lineHeight: 22,
  },
  thinkingLabel: {
    color: '#555',
    fontSize: 11,
    fontStyle: 'italic',
    marginBottom: 2,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  thinkingText: {
    color: '#666',
    fontStyle: 'italic',
  },

  // Tool calls — compact inline
  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginBottom: 4,
    gap: 6,
  },
  toolIcon: {
    color: '#5e5ce6',
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: 'bold',
  },
  toolDone: {
    color: '#30d158',
    fontSize: 13,
  },
  toolName: {
    color: '#8e8e93',
    fontSize: 13,
    fontFamily: 'monospace',
  },
  toolSpinner: {
    color: '#555',
    fontSize: 13,
  },
  toolResult: {
    color: '#555',
    fontSize: 12,
    fontFamily: 'monospace',
    flex: 1,
  },

  // Turn separators
  turnLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#222',
    marginVertical: 12,
  },
  turnEndRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginVertical: 4,
  },
  turnEndText: {
    color: '#444',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },

  // Service messages
  serviceRow: {
    alignItems: 'center',
    marginVertical: 8,
  },
  serviceText: {
    color: '#555',
    fontSize: 12,
    fontStyle: 'italic',
  },
});
