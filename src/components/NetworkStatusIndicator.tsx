import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { WifiOff, Wifi, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AnimatePresence, motion } from 'framer-motion';

export function NetworkStatusIndicator() {
  const { isOnline, wasOffline, effectiveType } = useNetworkStatus();

  const isSlowConnection = effectiveType === 'slow-2g' || effectiveType === '2g';

  // Don't show anything if online and no issues
  if (isOnline && !wasOffline && !isSlowConnection) {
    return null;
  }

  return (
    <AnimatePresence>
      {!isOnline && (
        <motion.div
          initial={{ y: -100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -100, opacity: 0 }}
          transition={{ type: 'spring', damping: 20, stiffness: 300 }}
          className="fixed top-0 start-0 end-0 z-[100] px-4 py-2 bg-destructive text-destructive-foreground"
        >
          <div className="flex items-center justify-center gap-2 text-sm font-medium">
            <WifiOff className="w-4 h-4" />
            <span>You're offline. Some features may not work.</span>
          </div>
        </motion.div>
      )}

      {isOnline && wasOffline && (
        <motion.div
          initial={{ y: -100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -100, opacity: 0 }}
          transition={{ type: 'spring', damping: 20, stiffness: 300 }}
          className="fixed top-0 start-0 end-0 z-[100] px-4 py-2 bg-green-600 text-white"
        >
          <div className="flex items-center justify-center gap-2 text-sm font-medium">
            <Wifi className="w-4 h-4" />
            <span>Back online!</span>
          </div>
        </motion.div>
      )}

      {isOnline && isSlowConnection && !wasOffline && (
        <motion.div
          initial={{ y: -100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -100, opacity: 0 }}
          transition={{ type: 'spring', damping: 20, stiffness: 300 }}
          className="fixed top-0 start-0 end-0 z-[100] px-4 py-2 bg-yellow-600 text-white"
        >
          <div className="flex items-center justify-center gap-2 text-sm font-medium">
            <AlertTriangle className="w-4 h-4" />
            <span>Slow connection detected. Pages may load slowly.</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
