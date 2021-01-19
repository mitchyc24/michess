import pygame

from Game import *

PIECES = {
        "k":"King",
        "q":"Queen",
        "r":"Rook",
        "b":"Bishop",
        "n":"Knight",
        "p":"Pawn",
        "K":"King",
        "Q":"Queen",
        "R":"Rook",
        "B":"Bishop",
        "N":"Knight",
        "P":"Pawn"
}

MOVESET = {
        "King" :  [(-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)]

}


def get_available_moves(game, pos):
        piece = game.get_piece_at(pos)
        piece_type = PIECES[piece]
        print(MOVESET[piece_type])
