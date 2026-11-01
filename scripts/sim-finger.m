// Touches a booted simulator from inside it, as its own dtuhidd does, but each event stamped with the time it was meant
// for, so that a runner too busy to send it on time cannot change how long a finger was down by the page's clock:
//
//   xcrun --sdk iphonesimulator clang -fobjc-arc -arch arm64 -mios-simulator-version-min=17.0 -framework Foundation \
//     -o build/sim-finger scripts/sim-finger.m
//   xcrun simctl spawn UDID build/sim-finger WIDTH HEIGHT        the screen in points
//
// Reads a JSON line per gesture on stdin and answers each with a JSON line, as scripts/sim-hid.py does:
//
//   {"touches": [[ms, "down" | "move" | "up", x, y], ...]}   one finger, each event ms after the one before, in points
//   -> {"ok": true, "stamped": [ms...], "sent": [ms...]}     each event's stamp and when it went, on the wall clock
//   {"senders": true} -> {"ok": true, "senders": [...]}       the touchscreens, as which a touch may come
//   {"sender": "ID"}                                         touch as that one from now on
//   {"keys": [[ms, "down" | "up", usage], ...]}              keys by HID usage, each after its wait, as the keyboard
//   -> {"ok": true, "stamped": [ms...], "sent": [ms...]}     dtuhidd adds once idb connects
//
// A key's down and up go from here one after the other, as idb sends them over a busy runner as two, and iOS repeated an
// Enter whose up came 913 ms after its down.
//
// Which touchscreen Safari hears is told by trying them: once idb connects, dtuhidd adds its own, one per display, and
// only the main display's is heard; the simulator's own then go.
//
// WebKit's event timeStamp is the HID event's.
#import <Foundation/Foundation.h>
#include <dlfcn.h>
#include <mach/mach_time.h>
#include <time.h>

typedef void *Ev;
typedef void *Client;
static Client (*ClientCreateWithType)(CFAllocatorRef, int, CFDictionaryRef);
static void (*Dispatch)(Client, Ev);
static Ev (*Digitizer)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, double, double, double, double, double, Boolean, Boolean, uint32_t);
static Ev (*Keyboard)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, Boolean, uint32_t);
static Ev (*Finger)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, double, double, double, double, double, Boolean, Boolean, uint32_t);
static void (*Append)(Ev, Ev, uint32_t);
static void (*SetInt)(Ev, uint32_t, long);
static void (*SetSender)(Ev, uint64_t);
static CFArrayRef (*CopyServices)(Client);
static CFTypeRef (*CopyProperty)(void *, CFStringRef);
static CFTypeRef (*RegistryID)(void *);

enum { KEYBOARD_PAGE = 7, RANGE = 0x1, TOUCH = 0x2, POSITION = 0x4, HAND = 3, DISPLAY_INTEGRATED = (11 << 16) + 25 };

static double wall(void) {
  struct timespec t;
  clock_gettime(CLOCK_REALTIME, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

static Ev event(uint64_t at, double x, double y, NSString *phase, uint64_t sender) {
  bool down = ![phase isEqualToString:@"up"];
  uint32_t mask = [phase isEqualToString:@"move"] ? POSITION : RANGE | TOUCH;
  Ev hand = Digitizer(NULL, at, HAND, 0, 0, mask, 0, 0, 0, 0, 0, 0, down, down, 0);
  SetInt(hand, DISPLAY_INTEGRATED, 1);
  Ev finger = Finger(NULL, at, 2, 2, mask, x, y, 0, down ? 1 : 0, 0, down, down, 0);
  Append(hand, finger, 0);
  CFRelease(finger);
  SetSender(hand, sender);
  return hand;
}

/** The touchscreens, dtuhidd's first, by a client made for it: one made earlier lists those of when it was made, and
 * dtuhidd adds its own as idb connects. */
static NSArray *touchscreens(void) {
  NSMutableArray *found = [NSMutableArray array];
  Client client = ClientCreateWithType(NULL, 1, NULL);
  CFArrayRef services = CopyServices(client);
  for (CFIndex i = 0; services && i < CFArrayGetCount(services); i++) {
    void *s = (void *)CFArrayGetValueAtIndex(services, i);
    NSNumber *page = (__bridge_transfer NSNumber *)CopyProperty(s, CFSTR("PrimaryUsagePage"));
    NSNumber *usage = (__bridge_transfer NSNumber *)CopyProperty(s, CFSTR("PrimaryUsage"));
    if (page.intValue != 0xD || usage.intValue != 0x4) continue;
    NSString *transport = (__bridge_transfer NSString *)CopyProperty(s, CFSTR("Transport"));
    NSString *display = (__bridge_transfer NSString *)CopyProperty(s, CFSTR("displayUUID"));
    [found addObject:@{@"id": [(__bridge NSNumber *)RegistryID(s) stringValue], @"transport": transport ?: @"", @"display": display ?: @""}];
  }
  if (services) CFRelease(services);
  CFRelease(client);
  [found sortUsingComparator:^(NSDictionary *a, NSDictionary *b) { return [b[@"transport"] compare:a[@"transport"]]; }];
  return found;
}

/** dtuhidd's keyboard, as for its touchscreens by a client made for it; 0 before idb has connected. */
static uint64_t keyboard(void) {
  uint64_t found = 0;
  Client client = ClientCreateWithType(NULL, 1, NULL);
  CFArrayRef services = CopyServices(client);
  for (CFIndex i = 0; services && i < CFArrayGetCount(services); i++) {
    void *s = (void *)CFArrayGetValueAtIndex(services, i);
    NSString *product = (__bridge_transfer NSString *)CopyProperty(s, CFSTR("Product"));
    if ([product isEqualToString:@"CoreDevice keyboard"]) found = [(__bridge NSNumber *)RegistryID(s) unsignedLongLongValue];
  }
  if (services) CFRelease(services);
  CFRelease(client);
  return found;
}

static void answer(NSDictionary *d) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:d options:0 error:nil];
  fwrite(json.bytes, 1, json.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc != 3) {
      fprintf(stderr, "usage: sim-finger WIDTH HEIGHT\n");
      return 2;
    }
    double width = atof(argv[1]), height = atof(argv[2]);
    void *io = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW);
    ClientCreateWithType = dlsym(io, "IOHIDEventSystemClientCreateWithType");
    Dispatch = dlsym(io, "IOHIDEventSystemClientDispatchEvent");
    Digitizer = dlsym(io, "IOHIDEventCreateDigitizerEvent");
    Finger = dlsym(io, "IOHIDEventCreateDigitizerFingerEvent");
    Keyboard = dlsym(io, "IOHIDEventCreateKeyboardEvent");
    Append = dlsym(io, "IOHIDEventAppendEvent");
    SetInt = dlsym(io, "IOHIDEventSetIntegerValue");
    SetSender = dlsym(io, "IOHIDEventSetSenderID");
    CopyServices = dlsym(io, "IOHIDEventSystemClientCopyServices");
    CopyProperty = dlsym(io, "IOHIDServiceClientCopyProperty");
    RegistryID = dlsym(io, "IOHIDServiceClientGetRegistryID");
    // an admin client, which may dispatch
    Client client = ClientCreateWithType(NULL, 1, NULL);
    uint64_t sender = 0;
    NSArray *found = touchscreens();
    if (!found.count) {
      answer(@{@"error": @"no touchscreen"});
      return 1;
    }
    sender = strtoull([found[0][@"id"] UTF8String], NULL, 10);
    mach_timebase_info_data_t tb;
    mach_timebase_info(&tb);
    double ticksPerMs = 1e6 * tb.denom / tb.numer;
    answer(@{@"ok": @YES});
    char *line = NULL;
    size_t size = 0;
    while (getline(&line, &size, stdin) > 0) {
      @autoreleasepool {
        NSDictionary *c = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:line length:strlen(line)] options:0 error:nil];
        if (c[@"senders"]) {
          answer(@{@"ok": @YES, @"senders": touchscreens()});
          continue;
        }
        if ([c[@"sender"] isKindOfClass:NSString.class]) {
          sender = strtoull([c[@"sender"] UTF8String], NULL, 10);
          answer(@{@"ok": @YES});
          continue;
        }
        NSArray *touches = c[@"touches"], *keys = c[@"keys"];
        uint64_t keys_from = 0;
        if ([keys isKindOfClass:NSArray.class] && !(keys_from = keyboard())) {
          answer(@{@"error": @"no keyboard: idb has not connected"});
          continue;
        }
        if (![touches isKindOfClass:NSArray.class] && !keys_from) {
          answer(@{@"error": [NSString stringWithFormat:@"unknown command %s", line]});
          continue;
        }
        // the gesture's clock, from its start on both clocks at once
        uint64_t start = mach_absolute_time();
        double startWall = wall();
        double at = 0;
        NSMutableArray *stamped = [NSMutableArray array], *sent = [NSMutableArray array];
        for (NSArray *t in keys_from ? keys : touches) {
          at += [t[0] doubleValue];
          uint64_t due = start + (uint64_t)(at * ticksPerMs);
          // on time where the runner allows, and stamped on time where it does not
          uint64_t now = mach_absolute_time();
          if (now < due) usleep((useconds_t)((due - now) / ticksPerMs * 1000));
          Ev e;
          if (keys_from) {
            e = Keyboard(NULL, due, KEYBOARD_PAGE, [t[2] unsignedIntValue], [t[1] isEqualToString:@"down"], 0);
            SetSender(e, keys_from);
          } else {
            e = event(due, [t[2] doubleValue] / width, [t[3] doubleValue] / height, t[1], sender);
          }
          Dispatch(client, e);
          CFRelease(e);
          [sent addObject:@(wall())];
          [stamped addObject:@(startWall + at)];
        }
        answer(@{@"ok": @YES, @"stamped": stamped, @"sent": sent});
      }
    }
    return 0;
  }
}
