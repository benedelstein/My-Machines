//
//  Environment+Haptics.swift
//  CloudeCode
//
//  Created by Ben Edelstein on 6/23/26.
//
import SwiftUI

extension EnvironmentValues {
    @Entry
    var hapticFeedbackPlayer: any HapticFeedbackPlaying = NoopHapticFeedbackPlayer()
}
