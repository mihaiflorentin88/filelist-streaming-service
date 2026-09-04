import { useEffect, useState } from 'preact/hooks';
import { Download, DownloadTransferAction } from '@filelist/shared';
import { Downloads, captureDownloadAnchor, reconcileDownloads, restoreDownloadAnchor } from '@filelist/web/downloads';
import { sharedApi } from '@filelist/web/shared-api';
import { useServerState } from '../lib/state';

// Downloads over the shared web view: this page owns only the data loop
// (poll, reconcile, scroll anchor) and the not-running gate; toolbar,
// cards, and the removal confirm come from @filelist/web/downloads.
export function DownloadsPage() {
  const server = useServerState();
  const [items, setItems] = useState<Download[]>([]);
  useEffect(() => {
    if (server.state !== 'running') return;
    let stopped = false;
    const load = async () => {
      try {
        const incoming = (await sharedApi().downloads()).items;
        if (stopped) return;
        const anchor = captureDownloadAnchor();
        setItems(current => reconcileDownloads(current, incoming));
        // Restore after Preact commits the reconciled list so visible rows
        // hold their viewport position across polls.
        requestAnimationFrame(() => restoreDownloadAnchor(anchor));
      } catch { /* keep the last good list; an empty list shows the view's own empty box */ }
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => { stopped = true; clearInterval(timer) };
  }, [server.state]);
  if (server.state !== 'running') {
    return <section class="empty-state"><h2>Server is {server.state}</h2><p>Start the server to see downloads.</p></section>;
  }
  return <Downloads
    items={items}
    onRefresh={() => { }}
    onPlay={() => { /* Task 10: open the watch URL in the default browser via Wails bindings */ }}
    onRemove={async download => { await sharedApi().deleteDownload(download.id) }}
    onAction={async (download, action: DownloadTransferAction) => { await sharedApi().call(`/downloads/${encodeURIComponent(download.id)}/${action}`, { method: 'POST' }) }}
  />;
}
