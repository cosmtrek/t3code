import { useResolveClassNames } from "uniwind";
import { themeColorWithContrast } from "../../lib/mobileTheme";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  BotActivity,
  BotDetail,
  BotQuestion,
  PendingBotMessage,
  ShownBotMessage,
} from "@t3tools/fork-client/bots";
import {
  pendingBotMessage,
  startsChatBreak,
  withPendingMessages,
} from "@t3tools/fork-client/bots";
import type { ForkEvent } from "@t3tools/fork-client/sse";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type * as React from "react";
import { Fragment, useEffect, useEffectEvent, useRef, useState } from "react";
import { AppState, Platform, Pressable, ScrollView, View } from "react-native";
import { useMessages } from "gt-react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";

import { useComposerBottomInset } from "../../components/ComposerSurface";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useMarkdownPreviewStyles } from "../../features/files/FileMarkdownPreview";
import { IssueCommentComposer } from "../../features/issues/IssueCommentComposer";
import { useAdaptiveWorkspaceLayout } from "../../features/layout/AdaptiveWorkspaceLayout";
import { useAndroidWorkspaceBack } from "../../features/layout/workspace/useAndroidWorkspaceNavigation";
import { useOpenThreadLink } from "../../features/threads/useOpenThreadLink";
import { ANDROID_READING_MAX_WIDTH, CHAT_CONTENT_MAX_WIDTH } from "../../lib/layout";
import { tryOpenWebLink } from "../../lib/openExternalUrl";
import { relativeTime } from "../../lib/time";
import { deriveBottomControlInsets, type NativeLayoutMetrics } from "../../lib/reserved-regions";
import { NativeLayoutObserver } from "../../native/NativeLayoutObserver";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useDeviceType, useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { asForkError, forkRequest, subscribeToForkEvents } from "../forkApi";
import { useForkResource } from "../useForkResource";
import { botFileLink } from "./botFileLink";
import { botStepLabel } from "./botStep";

export type BotParams = {
  readonly environmentId: string;
  readonly botId: string;
};

/** Within this distance of the end, new messages keep the chat scrolled to the newest. */
const STICK_TO_END_DISTANCE = 80;

export function BotRouteScreen({ route }: StaticScreenProps<BotParams>) {
  return (
    <BotRoute
      key={`${route.params.environmentId}:${route.params.botId}`}
      environmentId={EnvironmentId.make(route.params.environmentId)}
      botId={route.params.botId}
    />
  );
}

/** A bot's chat, as the desktop bot page shows it: its posts, its questions, and a composer. */
function BotRoute(props: { readonly environmentId: EnvironmentId; readonly botId: string }) {
  const { environmentId, botId } = props;
  const navigation = useNavigation();
  const returnToList = useAndroidWorkspaceBack();
  const { layout } = useAdaptiveWorkspaceLayout();
  const openThreadRef = useOpenThreadLink(environmentId);
  const markdown = useMarkdownPreviewStyles();
  const composerBottomInset = useComposerBottomInset();
  const deviceType = useDeviceType();
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const [screenMetrics, setScreenMetrics] = useState<NativeLayoutMetrics | null>(null);
  const columnMetrics = useNativeColumnLayoutMetrics();
  const controlInsets = deriveBottomControlInsets(
    usesNativeWorkspaceColumns ? columnMetrics : screenMetrics,
  );
  const [composerFocused, setComposerFocused] = useState(false);
  const [dockHeight, setDockHeight] = useState(0);
  const [pending, setPending] = useState<ReadonlyArray<PendingBotMessage>>([]);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const nearEnd = useRef(true);

  const detail = useForkResource<BotDetail>(
    environmentId,
    `/bots/bot?botId=${encodeURIComponent(botId)}`,
    (event: ForkEvent) => event.type === "bots" && event.botId === botId,
  );
  const data = detail.data;
  const activity = usePushedActivity(environmentId, botId, data);
  useMarkSeen(environmentId, botId, data);

  const openThread = (threadId: string) =>
    openThreadRef(scopeThreadRef(environmentId, ThreadId.make(threadId)));
  const onLinkPress = (href: string) => {
    const link = parseThreadLinkHref(href);
    if (link) {
      openThreadRef(scopeThreadRef(link.environmentId ?? environmentId, link.threadId));
      return;
    }
    const file = data
      ? botFileLink(href, {
          environmentId,
          workThreadId: data.bot.workThreadId,
          workspacePath: data.workspacePath,
        })
      : null;
    if (file?.screen === "ThreadFile") {
      navigation.navigate(file.screen, file.params);
      return;
    }
    if (file?.screen === "NewTaskFile") {
      navigation.navigate(file.screen, file.params);
      return;
    }
    void tryOpenWebLink(href, "markdown-link");
  };

  const chat = withPendingMessages(data?.chat ?? [], pending);
  // The server starts the bot's turn before it answers, so the message shows before that.
  const send = (text: string) => {
    const entry = pendingBotMessage(text, data?.chat ?? []);
    const shown = new Set(chat.map((line) => line.id));
    setPending((current) => [...current.filter((other) => shown.has(other.key)), entry]);
    setError(null);
    nearEnd.current = true;
    void forkRequest(environmentId, "/bots/send", {
      method: "POST",
      body: { botId, text: entry.text },
    }).then(
      () => detail.refresh(),
      (cause: unknown) => {
        setError(asForkError(cause).message);
        setPending((current) =>
          current.map((other) => (other === entry ? { ...other, failed: true } : other)),
        );
      },
    );
    return Promise.resolve(true);
  };
  const retry = (entry: PendingBotMessage) => {
    setPending((current) => current.filter((other) => other !== entry));
    void send(entry.text);
  };
  const setPaused = (paused: boolean) => {
    setError(null);
    void forkRequest(environmentId, "/bots/pause", {
      method: "POST",
      body: { botId, paused },
    }).then(
      () => detail.refresh(),
      (cause: unknown) => setError(asForkError(cause).message),
    );
  };

  const workThreadId = data?.bot.workThreadId ?? null;
  const subtitle = !data
    ? null
    : data.workingSince !== null
      ? `Working · ${relativeTime(data.workingSince)}`
      : data.bot.paused
        ? "Paused"
        : null;
  const contentMaxWidth =
    Platform.OS === "android"
      ? ANDROID_READING_MAX_WIDTH
      : layout.usesSplitView
        ? CHAT_CONTENT_MAX_WIDTH
        : undefined;
  const question = data?.questions[0] ?? null;

  return (
    <View className="flex-1 bg-screen">
      <AppBar
        title={data?.bot.name ?? ""}
        subtitle={subtitle}
        onBack={layout.usesSplitView ? undefined : returnToList}
        menus={[
          {
            title: "Bot actions",
            icon: "ellipsis",
            items: [
              ...(workThreadId === null
                ? []
                : [
                    {
                      id: "work-thread",
                      title: "Open work thread",
                      icon: "bubble.left",
                      onPress: () => openThread(workThreadId),
                    },
                  ]),
              ...(data
                ? [
                    data.bot.paused
                      ? {
                          id: "resume",
                          title: "Resume",
                          icon: "arrow.clockwise",
                          onPress: () => setPaused(false),
                        }
                      : {
                          id: "pause",
                          title: "Pause",
                          icon: "slash.circle",
                          onPress: () => setPaused(true),
                        },
                  ]
                : []),
            ],
          },
        ]}
      />
      <ScreenContent>
        {!usesNativeWorkspaceColumns ? <NativeLayoutObserver onChange={setScreenMetrics} /> : null}
        <NativeScrollView
          ref={scrollRef}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          scrollEventThrottle={64}
          onScroll={({ nativeEvent }) => {
            const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
            nearEnd.current =
              contentSize.height - contentOffset.y - layoutMeasurement.height <
              STICK_TO_END_DISTANCE;
          }}
          onContentSizeChange={() => {
            if (nearEnd.current) scrollRef.current?.scrollToEnd({ animated: false });
          }}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 8,
            paddingBottom: dockHeight + 16,
          }}
        >
          <View className="w-full gap-4 self-center" style={{ maxWidth: contentMaxWidth }}>
            {!data ? (
              detail.error ? (
                <EmptyState
                  title="Couldn't load this bot"
                  detail={detail.error.message}
                  variant="plain"
                />
              ) : (
                <AppActivityIndicator className="my-12" colorClassName="accent-icon" />
              )
            ) : chat.length === 0 ? (
              <EmptyState
                title="No messages yet"
                detail={`Write to ${data.bot.name} below.`}
                variant="plain"
              />
            ) : (
              chat.map((message, index) => (
                <Fragment key={message.id}>
                  {startsChatBreak(chat[index - 1], message) ? (
                    <ChatTimeDivider createdAt={message.createdAt} />
                  ) : null}
                  <ChatLine
                    message={message}
                    textStyle={markdown.nativeTextStyle}
                    onLinkPress={onLinkPress}
                    onRetry={retry}
                  />
                </Fragment>
              ))
            )}
            {data && data.workingSince !== null ? (
              <WorkingRow activity={activity} onOpen={openThread} />
            ) : null}
          </View>
        </NativeScrollView>
        <KeyboardStickyView
          enabled={deviceType !== "duo-unfolded" || composerFocused}
          pointerEvents="box-none"
          style={{ position: "absolute", bottom: 0, left: 0, right: 0, top: 0 }}
          offset={{ closed: 0, opened: composerBottomInset }}
        >
          <View
            pointerEvents="box-none"
            onLayout={(event) => setDockHeight(event.nativeEvent.layout.height)}
            style={{
              position: "absolute",
              bottom: controlInsets.bottom,
              left: controlInsets.left,
              right: controlInsets.right,
            }}
          >
            <View className="w-full gap-2 self-center px-3" style={{ maxWidth: contentMaxWidth }}>
              {error ? (
                <Text selectable className="px-1 text-sm text-danger-foreground">
                  {error}
                </Text>
              ) : null}
              {question ? (
                <QuestionCard
                  key={question.id}
                  environmentId={environmentId}
                  botId={botId}
                  question={question}
                  more={(data?.questions.length ?? 1) - 1}
                  onAnswered={detail.refresh}
                />
              ) : null}
              {data?.bot.paused ? (
                <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-2.5">
                  <SymbolView
                    name="slash.circle"
                    size={16}
                    tintColorClassName="accent-icon-muted"
                  />
                  <Text className="flex-1 text-sm text-foreground-muted">
                    Paused. It reads your messages when it resumes.
                  </Text>
                  <Button size="compact" label="Resume" onPress={() => setPaused(false)} />
                </View>
              ) : null}
            </View>
            <IssueCommentComposer
              ownerKey={`bot:${environmentId}:${botId}`}
              label={data?.bot.name ?? "Bot"}
              blocked={null}
              posting={false}
              bottomInset={composerBottomInset}
              contentMaxWidth={contentMaxWidth}
              copy={{
                placeholder: data ? `Message ${data.bot.name}` : "Message",
                send: "Send message",
                sending: "Sending message",
                submit: "Send",
              }}
              onSubmit={send}
              onHeightChange={() => undefined}
              onFocusChange={setComposerFocused}
            />
          </View>
        </KeyboardStickyView>
      </ScreenContent>
    </View>
  );
}

/** The live step line the server pushes between reads; a newer read carries it too, and wins. */
function usePushedActivity(
  environmentId: EnvironmentId,
  botId: string,
  data: BotDetail | null,
): BotActivity | null {
  const [pushed, setPushed] = useState<{
    readonly read: BotDetail | null;
    readonly activity: BotActivity;
  } | null>(null);
  const onActivity = useEffectEvent((activity: BotActivity) => setPushed({ read: data, activity }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the server's live status line for this bot's turn
  useEffect(
    () =>
      subscribeToForkEvents(environmentId, (event) => {
        if (
          event.type === "bot-activity" &&
          event.botId === botId &&
          event.text !== undefined &&
          event.threadId !== undefined
        ) {
          onActivity({
            text: event.text,
            threadId: event.threadId,
            ...(event.step === undefined ? {} : { step: event.step }),
          });
        }
      }),
    [environmentId, botId],
  );
  return pushed !== null && pushed.read === data ? pushed.activity : (data?.activity ?? null);
}

/** Tells the server the user has seen the bot's latest post, here or when the app comes back. */
function useMarkSeen(environmentId: EnvironmentId, botId: string, data: BotDetail | null) {
  const focused = useIsFocused();
  const lastPostId = data?.chat.findLast((message) => message.role !== "user")?.id ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports the seen post to the server while the screen shows it
  useEffect(() => {
    if (!focused || lastPostId === null) return;
    const markSeen = () => {
      if (AppState.currentState !== "active") return;
      void forkRequest(environmentId, "/bots/seen", { method: "POST", body: { botId } }).catch(
        () => undefined,
      );
    };
    markSeen();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") markSeen();
    });
    return () => subscription.remove();
  }, [environmentId, botId, lastPostId, focused]);
}

function ChatLine(props: {
  readonly message: ShownBotMessage;
  readonly textStyle: ReturnType<typeof useMarkdownPreviewStyles>["nativeTextStyle"];
  readonly onLinkPress: (href: string) => void;
  readonly onRetry: (entry: PendingBotMessage) => void;
}) {
  const { message } = props;
  const userStyle = useResolveClassNames("text-sm text-user-bubble-foreground bg-user-bubble");
  const userCodeStyle = useResolveClassNames("text-md-user-code-text bg-md-user-code-bg");
  const userFenceStyle = useResolveClassNames("bg-md-user-fence-bg");
  const userInlineCodeStyle = useResolveClassNames("text-user-bubble-foreground-muted");
  const userLinkStyle = useResolveClassNames("text-md-link");
  const userColor = String(userStyle.color);
  if (message.role === "user") {
    return (
      <View className="max-w-[88%] gap-1 self-end">
        <View className="rounded-2xl bg-user-bubble px-3.5 py-2.5">
          <SelectableMarkdownText
            markdown={message.text}
            textStyle={{
              ...props.textStyle,
              color: userColor,
              strongColor: userColor,
              mutedColor: userColor,
              fileTextColor: userColor,
              quoteMarkerColor: userColor,
              dividerColor: userColor,
              linkColor: themeColorWithContrast(
                String(userLinkStyle.color),
                String(userStyle.backgroundColor),
              ),
              inlineCodeColor: String(userInlineCodeStyle.color),
              codeColor: String(userCodeStyle.color),
              codeBackgroundColor: String(userCodeStyle.backgroundColor),
              codeBlockBackgroundColor: String(userFenceStyle.backgroundColor),
              fontSize: Number(userStyle.fontSize),
              lineHeight: Number(userStyle.lineHeight),
            }}
            onLinkPress={props.onLinkPress}
          />
        </View>
        {message.pending?.failed ? (
          <Pressable
            accessibilityRole="button"
            className="self-end pe-1"
            onPress={() => message.pending && props.onRetry(message.pending)}
          >
            <Text className="text-xs text-danger-foreground">Not sent · Tap to retry</Text>
          </Pressable>
        ) : message.turnRunId === null ? (
          <Text className="self-end pe-1 text-xs text-foreground-muted">Waiting for the bot</Text>
        ) : null}
      </View>
    );
  }
  if (message.role === "error") {
    return (
      <Text selectable className="px-1 text-sm text-danger-foreground">
        {message.text}
      </Text>
    );
  }
  if (message.text === "") return null;
  return (
    <SelectableMarkdownText
      markdown={message.text}
      textStyle={props.textStyle}
      onLinkPress={props.onLinkPress}
    />
  );
}

/** As a thread marks a new session, with the time the next message came. */
function ChatTimeDivider(props: { readonly createdAt: string }) {
  return (
    <View className="flex-row items-center gap-3 px-1">
      <View className="h-px min-w-4 flex-1 bg-separator" />
      <Text className="font-t3-medium text-xs text-foreground-muted tabular-nums">
        {chatTime(props.createdAt)}
      </Text>
      <View className="h-px min-w-4 flex-1 bg-separator" />
    </View>
  );
}

/** "14:49", "Yesterday 09:10" or "Nov 26 18:05". */
function chatTime(iso: string) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  const day = date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${day} ${time}`;
}

function WorkingRow(props: {
  readonly activity: BotActivity | null;
  readonly onOpen: (threadId: string) => void;
}) {
  const { activity } = props;
  const messages = useMessages();
  const text = activity === null ? null : (botStepLabel(activity.step, messages) ?? activity.text);
  const line = (
    <View className="flex-row items-center gap-2 px-1">
      <SymbolView
        name="circle.dashed"
        size={13}
        tintColorClassName="accent-adaptive-sky-600-400"
        type="monochrome"
        weight="semibold"
      />
      <Text className="flex-1 text-sm text-foreground-muted" numberOfLines={1}>
        {text ?? "Working"}
      </Text>
      {activity ? (
        <SymbolView name="chevron.right" size={11} tintColorClassName="accent-icon-muted" />
      ) : null}
    </View>
  );
  if (!activity) return line;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${text}, open thread`}
      onPress={() => props.onOpen(activity.threadId)}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {line}
    </Pressable>
  );
}

/** What the bot asked to do; approving runs exactly that. The details fold away. */
function QuestionCard(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly question: BotQuestion;
  readonly more: number;
  readonly onAnswered: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [what, ...rest] = props.question.text.split("\n\n");
  const details = rest.join("\n\n");
  const answer = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    await forkRequest(props.environmentId, "/bots/question/answer", {
      method: "POST",
      body: { botId: props.botId, questionId: props.question.id, approve },
    }).then(props.onAnswered, (cause: unknown) => {
      setError(asForkError(cause).message);
      setBusy(false);
    });
  };
  return (
    <View className="gap-2 rounded-2xl border border-border bg-card px-3.5 py-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="flex-row items-start gap-2"
        disabled={details === ""}
        onPress={() => setOpen(!open)}
      >
        <SymbolView
          name="questionmark.bubble"
          size={15}
          tintColorClassName="accent-adaptive-indigo-600-300"
          type="monochrome"
          weight="semibold"
        />
        <Text className="flex-1 text-sm text-foreground">
          Wants to <Text className="font-t3-medium">{what}</Text>
          {props.more > 0 ? (
            <Text className="text-foreground-muted">{` · ${props.more} more`}</Text>
          ) : null}
        </Text>
        {details !== "" ? (
          <SymbolView
            name="chevron.down"
            size={10}
            tintColorClassName="accent-icon-muted"
            style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}
          />
        ) : null}
      </Pressable>
      {open && details !== "" ? (
        <Text
          selectable
          numberOfLines={8}
          className="rounded-lg bg-subtle px-2.5 py-2 text-xs text-foreground-secondary"
        >
          {details}
        </Text>
      ) : null}
      {error ? <Text className="text-xs text-danger-foreground">{error}</Text> : null}
      <View className="flex-row justify-end gap-2">
        <Button
          size="compact"
          tone="text"
          label="Decline"
          disabled={busy}
          onPress={() => void answer(false)}
        />
        <Button
          size="compact"
          tone="primary"
          label="Approve"
          disabled={busy}
          onPress={() => void answer(true)}
        />
      </View>
    </View>
  );
}
