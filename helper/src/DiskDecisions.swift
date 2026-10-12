import Foundation

/// STC-527: what a take does when the disk under it fills. Pure — no
/// AVFoundation, no file system — so the classification is tested without a
/// full disk (helper/test/disk-full/), and the one thing only a full disk can
/// show (the error AVFoundation actually reports) is tested against a real
/// one there too.
///
/// Two ways in, and the take ends the same way through either:
/// - the WATCH (`decideDiskWatch`): free space polled every
///   `DISK_WATCH_INTERVAL_SECONDS`, stopping while there is still
///   `DISK_FREE_FLOOR_BYTES` left. This is the path a real take almost always
///   takes, and the better one: the writer still has room to finish the file,
///   so the take is a complete mp4 and not a crash-shaped prefix.
/// - the WRITER (`decideWriterFailure`): AVAssetWriter has already failed.
///   Something filled the disk faster than one poll, or the writer failed for
///   a reason that is not space at all. Measured on a real 16 MB APFS volume
///   (2026-10-12): the writer goes `.failed` with AVFoundationErrorDomain
///   -11807 "Disk Full" over NSPOSIXErrorDomain 28, and `isReadyForMoreMediaData`
///   simply turns false — `append` is never even called again. So the frame
///   path must read the writer's STATUS, not `append`'s return value; that
///   silence is why a full disk used to look like an endless run of dropped
///   frames.

/// Stop while this much is still free. One poll interval of writes at the
/// display's 50 Mbps (~6 MB) plus whatever an active camera adds, the last
/// fragment `finishWriting` still has to flush (`movieFragmentIntervalSec`,
/// 2 s, ~12 MB at the average rate and more at a VBR peak), and the
/// sidecars. 64 MiB covers that roughly twice over and is nothing on any disk
/// a person records to.
let DISK_FREE_FLOOR_BYTES: Int64 = 64 << 20

/// The heartbeat's own cadence, as the window watch uses (STC-370).
let DISK_WATCH_INTERVAL_SECONDS: Double = 1.0

/// Written at the start of a take and deleted just before the sidecars are,
/// so `anchors.json` and `events.json` have room even when the writer path,
/// not the watch, found the disk full. `anchors.json` is a few KB; this is
/// sized for `events.json` on a long take (about 30 min of busy cursor at
/// ~80 bytes an event). If `anchors.json` cannot be written, the take falls
/// into the crash path and the reason is lost (STC-505's open item).
let SIDECAR_RESERVE_BYTES = 8 << 20
let SIDECAR_RESERVE_FILE = ".sidecar-reserve"

enum DiskDecision: Equatable { case keepRecording; case stop(String) }

/// `freeBytes` nil means the volume could not be read. That is not a reason to
/// end someone's take; the writer path still catches a disk that really fills.
func decideDiskWatch(freeBytes: Int64?) -> DiskDecision {
    guard let free = freeBytes, free < DISK_FREE_FLOOR_BYTES else { return .keepRecording }
    return .stop("disk-full")
}

/// A failed display writer always ends the take: nothing more can be written,
/// and a take left "recording" past that point is the bug this ticket fixes.
/// The reason is `disk-full` when the error says so OR the volume is under the
/// floor (an error AVFoundation words differently on some later macOS should
/// not cost the user the right explanation), and the reserved `error`
/// otherwise.
func decideWriterFailure(_ error: Error?, freeBytes: Int64?) -> DiskDecision {
    if let error, isDiskFullError(error) { return .stop("disk-full") }
    if decideDiskWatch(freeBytes: freeBytes) != .keepRecording { return .stop("disk-full") }
    return .stop("error")
}

/// Any of the three ways Apple's stack says "out of space", anywhere in the
/// underlying-error chain. Domains are compared as strings so this file needs
/// no AVFoundation import.
func isDiskFullError(_ error: Error) -> Bool {
    func walk(_ e: NSError, depth: Int) -> Bool {
        if depth > 8 { return false }
        switch (e.domain, e.code) {
        case ("AVFoundationErrorDomain", -11807),            // AVError.diskFull
             (NSPOSIXErrorDomain, Int(ENOSPC)),
             (NSCocoaErrorDomain, NSFileWriteOutOfSpaceError):
            return true
        default:
            break
        }
        if let u = e.userInfo[NSUnderlyingErrorKey] as? NSError, walk(u, depth: depth + 1) { return true }
        if let us = e.userInfo[NSMultipleUnderlyingErrorsKey] as? [NSError] {
            return us.contains { walk($0, depth: depth + 1) }
        }
        return false
    }
    return walk(error as NSError, depth: 0)
}
