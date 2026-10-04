import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Terminal, History, Send, Webhook } from "lucide-react";
import { PlaygroundHeader } from "@/components/api-playground/PlaygroundHeader";
import { RequestHistoryPanel } from "@/components/api-playground/RequestHistoryPanel";
import { WebhookTester } from "@/components/api-playground/WebhookTester";
import { RequestBuilder } from "@/components/api-playground/RequestBuilder";
import { ResponseViewer } from "@/components/api-playground/ResponseViewer";
import { usePlaygroundState } from "@/components/api-playground/usePlaygroundState";
import { PLATFORMS } from "@/components/api-playground/types";

export default function ApiPlayground() {
  const state = usePlaygroundState();

  return (
    <div className="min-h-screen bg-background">
      <PlaygroundHeader isAuthenticated={!!state.user} />

      <main className="w-full px-6 py-8">
        {/* Hero */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl flex items-center justify-center bg-primary">
                <Terminal className="w-7 h-7 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-3xl font-bold">API Playground</h1>
                <p className="text-muted-foreground">Test API calls directly in your browser</p>
              </div>
            </div>
            <Button
              variant={state.showHistory ? "default" : "outline"}
              onClick={() => state.setShowHistory(!state.showHistory)}
              className="gap-2"
            >
              <History className="w-4 h-4" />
              History ({state.requestHistory.length})
            </Button>
          </div>
        </div>

        {/* History Panel */}
        {state.showHistory && (
          <RequestHistoryPanel
            requestHistory={state.requestHistory}
            fileInputRef={state.fileInputRef}
            onImport={state.importHistory}
            onExport={state.exportHistory}
            onClear={state.clearHistory}
            onLoad={state.loadFromHistory}
          />
        )}

        {/* Tabs */}
        <Tabs value={state.activeTab} onValueChange={(v) => state.setActiveTab(v as "post" | "webhook")} className="mb-6">
          <TabsList>
            <TabsTrigger value="post" className="gap-2"><Send className="w-4 h-4" /> Create Post</TabsTrigger>
            <TabsTrigger value="webhook" className="gap-2"><Webhook className="w-4 h-4" /> Webhook Tester</TabsTrigger>
          </TabsList>
        </Tabs>

        {state.activeTab === "webhook" ? (
          <WebhookTester
            webhookUrl={state.webhookUrl}
            setWebhookUrl={state.setWebhookUrl}
            apiKey={state.apiKey}
            isTestingWebhook={state.isTestingWebhook}
            webhookTestResult={state.webhookTestResult}
            onTest={state.testWebhook}
          />
        ) : (
          <div className="grid lg:grid-cols-2 gap-6">
            <RequestBuilder
              apiKey={state.apiKey}
              setApiKey={state.setApiKey}
              fetchAccounts={state.fetchAccounts}
              isFetchingAccounts={state.isFetchingAccounts}
              selectedPlatforms={state.selectedPlatforms}
              togglePlatform={state.togglePlatform}
              getAccountsForPlatform={state.getAccountsForPlatform}
              isAccountSelected={state.isAccountSelected}
              toggleAccountForPlatform={state.toggleAccountForPlatform}
              accounts={state.accounts}
              operation={state.operation}
              setOperation={state.setOperation}
              caption={state.caption}
              setCaption={state.setCaption}
              mediaUrl={state.mediaUrl}
              setMediaUrl={state.setMediaUrl}
              firstComment={state.firstComment}
              setFirstComment={state.setFirstComment}
              showAdvanced={state.showAdvanced}
              setShowAdvanced={state.setShowAdvanced}
              scheduledDate={state.scheduledDate}
              setScheduledDate={state.setScheduledDate}
              timezone={state.timezone}
              setTimezone={state.setTimezone}
              instagramShareToFeed={state.instagramShareToFeed}
              setInstagramShareToFeed={state.setInstagramShareToFeed}
              tiktokPrivacy={state.tiktokPrivacy}
              setTiktokPrivacy={state.setTiktokPrivacy}
              youtubePrivacy={state.youtubePrivacy}
              setYoutubePrivacy={state.setYoutubePrivacy}
              youtubeCategoryId={state.youtubeCategoryId}
              setYoutubeCategoryId={state.setYoutubeCategoryId}
              twitterReplySettings={state.twitterReplySettings}
              setTwitterReplySettings={state.setTwitterReplySettings}
              linkedinVisibility={state.linkedinVisibility}
              setLinkedinVisibility={state.setLinkedinVisibility}
              pinterestBoardId={state.pinterestBoardId}
              setPinterestBoardId={state.setPinterestBoardId}
              pinterestLink={state.pinterestLink}
              setPinterestLink={state.setPinterestLink}
              isLoading={state.isLoading}
              sendRequest={state.sendRequest}
            />
            <ResponseViewer
              requestBody={state.requestBody}
              generateCurl={state.generateCurl}
              response={state.response}
              copiedCode={state.copiedCode}
              copyCode={state.copyCode}
            />
          </div>
        )}

        {/* Quick Links */}
        <div className="mt-8 pt-8 border-t border-border">
          <h3 className="text-lg font-semibold mb-4">Platform Documentation</h3>
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map((platform) => (
              <Link key={platform} to={`/docs/${platform}-api`}>
                <Button variant="outline" size="sm" className="gap-2">
                  <PlatformIcon platform={platform} size="xs" />
                  {getPlatformName(platform)} API
                </Button>
              </Link>
            ))}
            <Link to="/docs/webhooks">
              <Button variant="outline" size="sm" className="gap-2">
                <Webhook className="w-4 h-4" /> Webhooks
              </Button>
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
