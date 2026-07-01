/* _GNU_SOURCE exposes struct ucred / SO_PEERCRED on Linux (glibc); must precede includes.
   Harmless on macOS, which uses the __APPLE__ getpeereid/LOCAL_PEERPID path below. */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <libproc.h>
#include <sys/un.h>
#endif

#if defined(__linux__)
#include <fcntl.h>
#endif

static void die(const char *message) {
  fprintf(stderr, "%s: %s\n", message, strerror(errno));
  exit(2);
}

static void start_time_for_pid(pid_t pid, char *buffer, size_t buffer_len) {
#if defined(__APPLE__)
  struct proc_bsdinfo info;
  int rc = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (rc <= 0) {
    snprintf(buffer, buffer_len, "unknown-%d", (int)pid);
    return;
  }
  snprintf(buffer, buffer_len, "%lld.%ld", (long long)info.pbi_start_tvsec, (long)info.pbi_start_tvusec);
#elif defined(__linux__)
  char path[64];
  snprintf(path, sizeof(path), "/proc/%d/stat", (int)pid);
  FILE *file = fopen(path, "r");
  if (!file) {
    snprintf(buffer, buffer_len, "unknown-%d", (int)pid);
    return;
  }
  char statbuf[4096];
  if (!fgets(statbuf, sizeof(statbuf), file)) {
    fclose(file);
    snprintf(buffer, buffer_len, "unknown-%d", (int)pid);
    return;
  }
  fclose(file);
  char *after_comm = strrchr(statbuf, ')');
  if (!after_comm) {
    snprintf(buffer, buffer_len, "unknown-%d", (int)pid);
    return;
  }
  char *cursor = after_comm + 2;
  char *token = strtok(cursor, " ");
  int field = 3;
  while (token && field < 22) {
    token = strtok(NULL, " ");
    field++;
  }
  snprintf(buffer, buffer_len, "%s", token ? token : "unknown");
#else
  snprintf(buffer, buffer_len, "unknown-%d", (int)pid);
#endif
}

static void print_credential(const char *platform, pid_t pid, uid_t uid, gid_t gid) {
  char start[128];
  start_time_for_pid(pid, start, sizeof(start));
  printf("{\"platform\":\"%s\",\"pid\":%d,\"uid\":%d,\"gid\":%d,\"startTime\":\"%s\"}\n",
         platform, (int)pid, (int)uid, (int)gid, start);
}

static void inspect_fd(int fd) {
#if defined(__APPLE__)
  pid_t peer_pid = 0;
  socklen_t pid_len = sizeof(peer_pid);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peer_pid, &pid_len) != 0) die("LOCAL_PEERPID failed");
  uid_t uid = 0;
  gid_t gid = 0;
  if (getpeereid(fd, &uid, &gid) != 0) die("getpeereid failed");
  print_credential("darwin", peer_pid, uid, gid);
#elif defined(__linux__)
  struct ucred cred;
  socklen_t cred_len = sizeof(cred);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &cred_len) != 0) die("SO_PEERCRED failed");
  print_credential("linux", cred.pid, cred.uid, cred.gid);
#else
  fprintf(stderr, "unsupported platform\n");
  exit(2);
#endif
}

static void selftest(void) {
  int fds[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, fds) != 0) die("socketpair failed");
  inspect_fd(fds[0]);
  close(fds[0]);
  close(fds[1]);
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "selftest") == 0) {
    selftest();
    return 0;
  }
  if (argc >= 3 && strcmp(argv[1], "fd") == 0) {
    inspect_fd(atoi(argv[2]));
    return 0;
  }
  fprintf(stderr, "usage: %s selftest | fd <inherited-fd>\n", argv[0]);
  return 64;
}
