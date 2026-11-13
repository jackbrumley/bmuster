---
layout: default
title: Code signing policy | BMuster
description: How BMuster's Windows programs are code signed, who can approve a signed release, and what the software sends over the network.
canonical: https://bmuster.com/code-signing-policy
---

# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## What is signed

The Windows programs in each [BMuster release](https://github.com/jackbrumley/bmuster/releases): the agent installed on each machine, its tray program, and the Windows server. They are built from the public source in this repository by GitHub Actions, and only those builds are submitted for signing. Nothing built on a personal computer is signed.

Releases up to and including 0.4.24 were published before signing was in place and are not Authenticode signed.

## Team roles

- Committers and reviewers: [Jack Brumley](https://github.com/jackbrumley)
- Approvers: [Jack Brumley](https://github.com/jackbrumley)

Every signing request is approved by hand. All accounts with access to the repository and to SignPath use multi-factor authentication.

## Separate update signing

Independently of Windows code signing, every BMuster release manifest is signed with the project's own Ed25519 release key, kept offline. The server and agents refuse any update that does not carry a valid signature from that key.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

BMuster is self-hosted. An agent connects only to the BMuster server it was enrolled with, which its owner runs. The server checks GitHub for new BMuster releases. Neither sends telemetry, and the project collects no data from anyone's installation.
