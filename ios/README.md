# Clip Maker for iOS

Clip Maker is a native SwiftUI editor. The app opens to a YouTube link field and uses a local library for projects and exports. The iOS workflow has no account screen.

## Run on a simulator

1. Install Node.js 22, yt-dlp, and FFmpeg. From the repository root, run `npm start`. The YouTube endpoints use yt-dlp and FFmpeg without a database or user login.
2. Open `ios/ShortsPro.xcodeproj` in Xcode and select the **ShortsPro** scheme and an iPhone simulator.
3. Press **⌘R**. The app appears as **Clip Maker**. Paste a public YouTube video link and tap **Analyze video**.

The simulator Debug target connects to `http://127.0.0.1:3000`. If yt-dlp is installed outside the server’s search path, set `CLIP_MAKER_YTDLP` to its absolute path before starting the server.

## Make a clip

1. Choose a suggested moment or select **Custom range**. Suggestions use replay activity or chapters when available.
2. Tap **Edit this clip**. Clip Maker imports that section into the native editor and includes available captions.
3. Trim, reframe, mute, or edit captions. For videos with speech, the editor can also generate captions on devices with Apple’s on-device recognition support.
4. Tap **Export MP4** to render on the device. Preview or share it with the iOS share sheet.

**Import a file instead** accepts Photos, Files, or direct HTTPS MP4/MOV links. Local video editing and MP4 export run on the device. After creating two exports, **Make reel** can combine up to five clips.

## Run on an iPhone

Select your Apple development team in **Signing & Capabilities** and choose the connected iPhone as the run destination. Set the target’s `CLIP_MAKER_SERVICE_URL` build setting to the HTTPS origin running the Clip Maker server for YouTube import.

The sample and its poster use the [MDN flower video](https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4).
