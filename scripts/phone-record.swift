// Records a USB-connected iPhone's screen, as QuickTime's movie recording does.
//
//   swiftc -O -o /tmp/phone-record scripts/phone-record.swift && /tmp/phone-record OUT.mov SECONDS
//
// The phone has to be unlocked and trust this Mac. Frames arrive at about 30 per second.
import AVFoundation
import CoreMediaIO

let args = CommandLine.arguments
guard args.count == 3, let seconds = Double(args[2]) else {
  FileHandle.standardError.write("usage: phone-record OUT.mov SECONDS\n".data(using: .utf8)!)
  exit(2)
}
let out = URL(fileURLWithPath: args[1])

// Without this, macOS hides iOS devices from capture.
var prop = CMIOObjectPropertyAddress(
  mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
  mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
  mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
var allow: UInt32 = 1
CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &prop, 0, nil, UInt32(MemoryLayout<UInt32>.size), &allow)

// The phone can take several seconds to appear after the property is set.
var device: AVCaptureDevice?
for _ in 0..<150 {
  device = AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: .muxed, position: .unspecified).devices.first
  if device != nil { break }
  RunLoop.main.run(until: Date().addingTimeInterval(0.1))
}
guard let device else {
  FileHandle.standardError.write("no iPhone found: is it connected, unlocked and trusting this Mac?\n".data(using: .utf8)!)
  exit(1)
}

/// AVCaptureMovieFileOutput refuses the phone's muxed stream, so frames are written as they arrive.
final class Writer: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  var writer: AVAssetWriter?
  var input: AVAssetWriterInput?
  var stopping = false
  var frames = 0

  func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
    if stopping { return }
    let time = CMSampleBufferGetPresentationTimeStamp(sample)
    if writer == nil, let format = CMSampleBufferGetFormatDescription(sample) {
      let size = CMVideoFormatDescriptionGetDimensions(format)
      let w = try! AVAssetWriter(outputURL: out, fileType: .mov)
      let i = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: size.width, AVVideoHeightKey: size.height,
      ])
      i.expectsMediaDataInRealTime = true
      w.add(i)
      w.startWriting()
      w.startSession(atSourceTime: time)
      writer = w
      input = i
    }
    if input?.isReadyForMoreMediaData == true, input?.append(sample) == true { frames += 1 }
  }
}

let session = AVCaptureSession()
session.addInput(try AVCaptureDeviceInput(device: device))
let output = AVCaptureVideoDataOutput()
let writer = Writer()
let queue = DispatchQueue(label: "frames")
output.setSampleBufferDelegate(writer, queue: queue)
session.addOutput(output)
try? FileManager.default.removeItem(at: out)
session.startRunning()
print("recording \(device.localizedName) for \(seconds) s")
DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
  queue.sync { writer.stopping = true }
  session.stopRunning()
  guard let w = writer.writer else {
    FileHandle.standardError.write("no frames: is the phone unlocked?\n".data(using: .utf8)!)
    exit(1)
  }
  writer.input?.markAsFinished()
  w.finishWriting {
    print("\(writer.frames) frames")
    exit(w.status == .completed ? 0 : 1)
  }
}
RunLoop.main.run()
