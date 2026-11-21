# Mobile real-device checklist

Run this on a **real iPhone (Safari) and a real Android phone (Chrome)** before telling a team to dial from their phones.
It covers what simulators and desktop browsers cannot: the real keyboard, the lock screen, Bluetooth audio, notch and home bar.
Use a QA-org account, never a customer org. Tick each box on each phone; write the phone model and OS next to a failure.

Phone: ____________ OS: ________ Browser: ________ Date: ________ Tester: ________

## 1. Sign-in

- [ ] The sign-in page fits with no sideways scroll. Tapping Email or Password does **not** zoom the page.
- [ ] The password manager offers to fill (Face ID / fingerprint). Signing in lands on the Dialer or Dashboard.
- [ ] The bottom tab bar sits above the home bar and is not covered by the browser's own toolbar.

## 2. Add to Home Screen

- [ ] iPhone: Share, Add to Home Screen. Android: menu, Install app / Add to Home screen.
- [ ] The icon is the HyperDial tile and the name reads "HyperDial".
- [ ] It opens full screen (no browser address bar). Sign in again if asked (installed apps keep their own login).
- [ ] The status bar clock and notch do not overlap the top bar.

## 3. Start a session and the microphone

- [ ] The phone tip ("Dialing from your phone?") shows once, "Got it" hides it for good.
- [ ] Tap Start. The browser asks for the microphone. **Allow**. The session starts.
- [ ] Sign out, deny the microphone once: the red message names your phone's steps (iPhone Settings or Android lock icon). After allowing, Start works.

## 4. The screen stays on

- [ ] During a session, leave the phone untouched for 2 minutes. The screen does **not** dim or lock.
- [ ] If it did dim: tap the screen once, wait, leave it again (iPhone only lets the page hold the screen after a tap).
- [ ] Note battery drop after 10 minutes of a live session: ______ %.

## 5. Lock the phone mid-session

- [ ] With a session running, press the side button to lock for 30 seconds, then unlock and open HyperDial.
- [ ] Within a few seconds a red banner reads **"Your phone line dropped while the screen was off"** with a **Reconnect** button (if the line really dropped).
- [ ] Tap Reconnect. The line comes back, dialing resumes, and a customer who was on the call was not hung up.
- [ ] Repeat by switching to another app for a minute and back.

## 6. Call audio and headphones

- [ ] Answer a test call. You hear the other side and they hear you (speaker, then earpiece).
- [ ] Plug in wired headphones, then Bluetooth headphones: audio and the microphone move over. Unplug mid-call: audio falls back to the phone without dropping the call.
- [ ] If call audio is silent, a "Tap to turn on call audio" button appears; tapping it fixes it.
- [ ] Mute, Hold, Transfer, Hang up are all easy to hit with a thumb (nothing smaller than a fingertip).

## 7. Wrap-up with the keyboard open

- [ ] After a call, the Wrap up window opens. Pick a disposition, tap the Notes box: the keyboard opens and **Submit stays visible above it**. The window header is still on screen.
- [ ] Open Log close and tap the lowest field (Email): same check. Close the keyboard with Done: nothing is left scrolled out of place.
- [ ] Same on a contact's Add contact form.

## 8. Notch, home bar and rotation

- [ ] Portrait: nothing is hidden under the notch/Dynamic Island, and the tab bar and modal buttons clear the home bar.
- [ ] Rotate to **landscape** on the Dialer, a modal (Wrap up, Add contact) and Shifts: the modal's buttons stay on screen, the body scrolls, nothing is cut off by the notch side.
- [ ] Rotate back: the layout recovers with no sideways scroll.

## 9. Everyday screens (agent, then a manager/admin account)

- [ ] Dashboard, Contacts, Inbox, Recordings, Shifts open with no sideways scroll; every button is easy to tap.
- [ ] A manager sees Analytics, Team, Settings, Pros and Team Shifts under More; an agent does not.
- [ ] Select menus (filters) open the phone's native picker.

Record failures with a screenshot and the phone model. Known limits: iPhone releases the screen-on lock whenever the page is hidden, so after returning, the first tap re-arms it.
