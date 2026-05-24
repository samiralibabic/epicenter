# Git's `index.lock` Is a Local Temp File, Not a Collaboration Lock

Git does not lock your source files while you edit them. You can save `file.ts` all day and Git will not create `.git/index.lock`, because Git is not watching your editor writes. The lock appears when Git itself needs to rewrite the staging area.

The staging area lives here:

```text
.git/index
```

That file is local metadata. It records paths, file modes, object hashes, staged entries, and merge conflict stages. It is not pushed to GitHub, and your coworkers never see it.

When Git updates that file, it uses the same pattern you would use for a safe file write:

```text
write the new content somewhere temporary
then rename it into place
```

For the index, the temporary path is also the lock:

```text
.git/index.lock
```

That means `index.lock` has two jobs at once. It tells other Git processes on the same machine to stay away from the index, and it holds the next version of the index until Git can rename it over `.git/index`.

The timeline looks like this:

```text
you edit file.ts
  no .git/index.lock

git add file.ts
  create .git/index.lock
  write updated staging metadata
  rename .git/index.lock -> .git/index
  lock is gone

git commit
  may update index metadata again
  lock appears briefly, then disappears
```

The important part is what does not happen. Git does not create a lock every time a file changes in your working tree. It creates one when a Git command needs to mutate Git's own metadata.

So this can create a lock:

```bash
git add file.ts
git reset file.ts
git switch feature-branch
git merge main
git rebase main
git stash
git commit
```

This does not:

```text
save file.ts in your editor
run prettier against file.ts
write logs to app.log
generate dist/bundle.js
```

Those writes change files in the working tree. The index only changes when Git stages, unstages, checks out, merges, or otherwise updates its local view of the repository.

This is why a stuck lock usually means something mundane:

```text
fatal: Unable to create '.git/index.lock': File exists.
```

Either a Git process is still running, an editor integration is running Git in the background, or a previous Git command crashed after creating the lock but before removing it.

If no Git command is running, removing the stale lock is usually fine:

```bash
rm .git/index.lock
```

But the order matters. First check that Git is not still doing work. If you delete the lock while another Git process is actively writing the index, you are removing the guard that prevents two local processes from corrupting the same metadata file.

The mental model is small:

```text
working tree writes
  ordinary file writes
  no index lock

Git index writes
  local metadata rewrite
  create .git/index.lock
  rename lock into .git/index
```

That is all `index.lock` is. Not a network lock. Not a collaboration lock. Not a permanent object. Just a local filesystem lock that doubles as the temporary replacement for Git's staging-area metadata.
