import Foundation

/// Free bytes on the volume holding `dir`, or nil if it cannot be read. The
/// raw free count, not "available for important usage": that one includes
/// purgeable space macOS may not reclaim fast enough for a writer at 50 Mbps,
/// and stopping a little early beats an ENOSPC mid-fragment.
///
/// The cache is cleared on EVERY read, and that is the whole point of this
/// function (STC-527, runbook §2, 2026-10-13). Foundation caches resource
/// values on the URL and drops them only when a run loop turns; the disk watch
/// is a `DispatchSourceTimer` on a global queue, which never turns one. So
/// reading a stored URL each tick returned the FIRST tick's free space for the
/// whole take — measured on a filling 64 MB volume: 55, 55, 55 MiB on the
/// stored URL against 55, 51, 47 MiB with the cache cleared — and the watch
/// never fired; on a real full disk the writer path caught it instead, with
/// ~5 MiB left rather than the floor. `helper/test/disk-full/` reads, writes
/// and reads again from a background queue, with the uncleared read as its
/// control.
///
/// Its own file rather than `DiskDecisions.swift`, which is pure and touches
/// no file system.
func volumeFreeBytes(at dir: URL) -> Int64? {
    var url = dir
    url.removeAllCachedResourceValues()
    let v = try? url.resourceValues(forKeys: [.volumeAvailableCapacityKey])
    return v?.volumeAvailableCapacity.map(Int64.init)
}
